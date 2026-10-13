# 非公開の全機械候補保存（本番未有効）

追加保存の初期値は無効です。通常の CLI、環境変数、workflow に有効化設定を追加していません。既存の検索キーワード、ページ数、詳細取得の上限80件、分類器、推薦、公開 summary の形式は変更しません。正常ページの注意書きによる誤判定の修正も維持します。

## 保存内容と照合

`src/private-candidates.js` を `runDaily` の明示的な `privateCandidateStore` オプションから呼び出せます。ローカルの専用ディレクトリと運用ポリシーがすべて指定された場合だけ保存します。`CI` / `GITHUB_ACTIONS` が設定された実行では有効化を拒否します。公開 Actions artifact やログに一覧を送るアダプターはありません。

1実行につき `<executionId>.json` だけを保存します。executionId は UUID v4 で、新しい `runDaily` 呼出しでは新しく発行します。明示した同じ executionId と抽出時刻による、完全に同じ記録の再保存だけが冪等になります。違う記録を同じIDへ保存しようとした場合は拒否します。

記録の許可リストは次の通りです。

- 各機械候補の公開案件ID、正規URL、取得時刻 `fetchedAt`、固定の機械抽出理由コード。
- 巡回開始時刻 `generatedAt`、候補配列が完成して保存処理へ渡された時刻 `extractedAt`。
- schema / Collector保存形式版、候補抽出・上限に関係する8ソースファイルの内容ハッシュ（改行をLFに統一）、executionId、既存 snapshot の runId。
- 元 snapshot、公開 summary の実際のJSONシリアライズ、候補保存記録のSHA256。
- 公開集計の機械候補数、一覧件数、取得件数と照合状態。

本文・タイトル・氏名・連絡先・プロフィール・私信・応募書類・自由文の理由・秘密値は保存しません。snapshot に混入した未知フィールドも投影しません。ソースの読み取り対象は `daily.js`、`collector.js`、`scraper.js`、`model.js`、`public-evidence.js`、`store.js`、`private-candidates.js`、`private-candidate-policy.js` だけで、認証ファイルや `.env` は読みません。

一覧件数と公開 `safeCandidates`、snapshot の candidateIds、candidate フラグ、coverage の候補件数を照合します。ID欠落、重複、正規参照との不一致も拒否し、黙って候補を減らしません。取得総数も照合します。未取得の `null` は `reconciliation: unknown`・一覧0件として保存し、確認済み0件の `matched` と区別します。

`assessment: machine_extraction_only` は抽出記録の意味です。応募適合・安全審査・本人承認の結果ではありません。コードの `machine_candidate` や従来名 `safeCandidates` も、安全保証・応募許可にはなりません。

## 保存境界と障害

保存先は絶対パスの専用ディレクトリを必須とします。この公開リポジトリ内では Git 管理外の `data/` 配下だけを許可し、公開出力先、`site/`、`public/`、`collector-data/`、`.github/` と親子の両方向で重なる場所を拒否します。既存の内部出力先とも親子の両方向で重なる場所を拒否するため、例えば `data/private-candidates/` と従来の `data/collector/` は分離します。既存親の symlink / junction も拒否します。出力側の別名も実パスで検査します。既存の公開コピーの許可リストは変更していません。

POSIX の新規保存ディレクトリは0700、ファイルは0600にし、既存保存先・記録のgroup/other許可は拒否します。Windowsではこの mode はACLを保証しません。ローカルディレクトリが本人だけに許可されているか、同期先や共有先が適切かは、本番有効化前の運用確認が必要です。外部パスを指定できることだけでは非公開性を証明できません。

保存は専用ロック、新規一時ファイル、fsync、上書きしない原子的なハードリンク公開を使います。ディレクトリエントリのfsyncは行わないため、電源断まで含めた耐久性は未検証です。ハードリンクを使えないファイルシステムやsandboxでは `private_candidates_storage_failed` で停止します。残存ロック・不明ファイル・破損記録は自動修復せず停止します。実行ID衝突でも既存記録を変更しません。接続済みDrive処理を注入する限定アダプタは別モジュールで、本番やrunnerからの転送は有効化していません。

保存・照合は、従来の内部 latest / 公開 summary を書く前に行います。保存エラーで従来の最新集計を上書きしません。保存完了後に従来出力が失敗した場合、候補記録は残ることがあります。その記録はメモリ内の summary との照合であり、公開・日次処理全体の成功を証明しません。`summarySha256` は保存後の公開 summary とも比較できます。

エラーは `private_candidates_...` という固定コードだけで、元のファイルシステム例外・パス・本文を外に渡しません。主なコードは `candidate_count_mismatch`、`candidate_limit`、`run_limit`、`byte_limit`、`retention_review_required`、`identity_collision`、`store_locked`、`storage_failed`、`cleanup_failed` です。`cleanup_failed` は記録が公開済みでも一時ファイルやロックの整理に失敗した可能性を表します。次の書込みで自動的に解除しません。既存の記録を確認してから対処してください。

## 承認済み上限と保管期間

2026-10-13に承認された上限を `private-candidate-policy.js` の変更不能な `APPROVED_POLICY` に定義しました。上限は保存を有効にしません。ローカル保存のオプションにはポリシーを明示し、承認値より小さい値は使用できますが、承認値を超える設定は拒否します。0、負数、非整数も拒否します。上限超過は切り捨てず失敗にします。

期限は `extractedAt` から30×24時間で、期限ちょうどを含めて到達後は `read` が `expired` / `requiresReview: true` だけを返し、候補本文・一覧を参照結果に含めません。Drive側の読み戻し検証も同様です。期限を過ぎた記録があればローカルの新規保存も停止します。期限切れ記録は残し、非公開の移動・削除を別途判断します。完全一致retryは新しい記録を増やしませんが、参照時の期限停止を解除することはありません。

| 項目 | 承認上限・単位 | 根拠 |
| --- | --- | --- |
| 1実行の候補上限 | 1記録あたり100候補 | 現在の詳細対象上限80件を収容し、抽出対象が増えた際に見直せる |
| 保管期間 | 抽出時刻から30×24時間 | 日次の候補比較を1か月分保持し、期限到達時に参照を止める |
| 実行記録上限 | 保存先のCollector専用記録60件 | 1 executionIdを1件と数える。候補0件・未知・合成試験・期限切れ記録も1件。日次＋限定的な手動実行を収容 |
| 保存総量 | 保存先のCollector専用記録合計5,242,880 bytes | UTF-8の実際の保存バイト数。Driveでは外側の合成ラベル・ハッシュを含むJSON全体。期限切れも削除するまで計上 |

ローカル保存先は専用ディレクトリ全体、Driveは指定フォルダ直下の `CW_PRIVATE_MACHINE_CANDIDATES_V1__` 名前領域を計上します。他のCompany OS文書には適用しません。上限・期限の増加や自動削除は別判断が必要です。保存先の担当者、Windows ACL、期限到達時の確認手順は未確定です。ChatGPTの既存Drive接続で合成試験記録1件の新規保存・raw全文読み戻し・非共有状態を確認しましたが、runnerの認証・接続・書込み権限・永続性は未検証です。新しい認証・権限・共有設定は追加していません。

## Drive限定試験アダプタ

`private-candidate-drive.js` は接続済みサービスの処理を `transport` として注入します。資格情報を読み取らず、新しい認証を作らず、HTTP取得も内蔵しません。初期値は無効、CIは拒否、現在は `synthetic: true` の固定合成試験形式だけを許可します。実候補の無人保存は未接続です。

記録には `SYNTHETIC_TEST` のファイル名、固定の合成試験ラベル・purpose、30日期限、最小候補payload、payload/envelope/全文のハッシュを使います。接続側は専用記録一覧の完全性・各ファイルの最新サイズ、folderとfileのownerのみ・非共有状態、アップロード前のホスト側元ファイルハッシュ、作成後のraw全文バイト列を検証する必要があります。既存の同じ記録は読み戻すだけで再作成しません。新規作成の試行は1回で消費し、応答不明でも自動再送しません。update/delete/share操作はありません。

今回の実接続では既知の新規fileIdでraw全文を取得し、1候補・1,717 bytes・完全SHA256一致と共有状態を確認しました。名前検索は作成直後のapplication/jsonも返さなかったため、現在の工具で専用名前領域を完全列挙できるとは認定していません。完全一覧を証明できない接続をアダプタに渡すと保存を拒否します。複数writerに対するDrive側の原子的な名前一意性やquotaロックも未保証です。この限定試験結果を、本番adapter全体やrunnerの無人保存が動くという証拠にはしません。

## runner接続前の停止条件

本実装は既定無効の準備実装です。現在のCLIは保存設定を受け取らず、既存workflowにはGoogle Driveの認証・転送ステップがありません。ChatGPT側の接続試験はGitHub runnerの接続・権限を証明しません。CI拒否と合成試験限定の条件は維持しています。

本番接続には、runnerが無人で使用できる承認済みの認証経路と、保存先に対する書き込み・メタデータ確認・専用記録の完全な列挙・raw全文読出しが必要です。新規OAuth接続、refresh tokenの継続保管、既存資格情報の別環境への設定、Secrets追加、権限追加は別承認です。既存の秘密値や認証ファイルを調査・取得する方法で解消しません。

通常のMy Driveフォルダでは、所有者のOAuth接続を候補とします。最小権限の出発点はGoogle Driveの `drive.file` ですが、選択したファイルとアプリ作成ファイルに限られるため、既存の専用記録まで完全に列挙できると仮定しません。容量上限を正しく検証するために必要な追加の可視性・scopeは、既存記録の扱いを具体化して別承認を得ます。サービスアカウントには保存容量がなくファイルを所有できないため、現在の通常フォルダへ単純に置き換える方式にはしません。

認証経路確定後に本番用transport・非合成記録・明示的なrunner設定を実装し、完全な専用一覧、上限、非共有状態、raw全文、件数・実行ID・ハッシュを検証します。その後に既存頻度で有効化し、新規dispatchは進行中runとmainのSHAを再確認してから行います。完全一覧や不明なアップロード結果を成功とみなさず、再送による重複作成を避けます。

根拠: [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)、[Drive service-account storage limitations](https://developers.google.com/workspace/drive/api/guides/handle-errors#storagequotaexceeded)。

## 検証とロールバック（準備実装）

回帰テストは隔離した一時ディレクトリと人工案件・模擬transportで行います。承認された実接続試験は一般正本を上書きせず、合成記録の新規作成1件と読取りだけです。実Collector巡回、応募、workflow実行、公開、push は行いません。回帰には全件保存・0/null・同じ件数のID入替え・上限境界・重複・秘密フィールド投影・保存障害・同一IDretry/衝突・期限参照停止・ロック・公開許可リスト・CI拒否・不完全一覧拒否・raw全文不一致・共有状態変化を含みます。

追加保存を停止するには `privateCandidateStore` を渡さない、または `enabled: false` にします。候補記録を削除せず、従来の集計経路へ戻ります。通常のCLI/workflowはもともと無効なので運用変更はありません。コードを戻す場合は `daily.js` の import・初期化・save 呼出しを除去し、新モジュールと専用テストだけを外します。前回の正常ページ修正は戻しません。
