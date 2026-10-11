# Collector の観測記録と公開業務履歴

## 出力と互換性

`runDaily` の戻り値と `latest.json` は従来の summary のキーを維持します。正常に取得した場合の `totalJobs` / `safeCandidates` は従来通り数値です。取得も解析もできない場合は `null` とし、正常取得した空一覧の `0` と区別します。検索の `attempts[].imported` も未取得では `null`、正常取得した空一覧では `0` です。`safeCandidates` は取得範囲の機械判定候補数であり、安全保証ではありません。

型の完全互換ではありません。数値のみを想定する consumer は nullable 対応が必要です。`Number(null)` や `value || 0` で未取得を0件へ変換しないでください。

推薦オブジェクトは従来の業務情報を維持し、未定義の追加フィールドを通過させません。メール・電話・ラベル付き個人情報・代表的な秘密情報は表示前に省略します。検索元URLは検索ページの正規パスだけにします。新しい観測記録と発注者照合にはタイトル・本文・氏名・連絡先・評価の自由文を保存しません。本文の変更検知はフィールド別ハッシュで行い、機械理由は既存分類器の固定キーワードとコードに限定します。

従来の公開 summary、HTML、Markdown は `site/` に生成します。追加観測は内部確認資料として、Git 管理外の `data/collector/` に分離します。`--evidence-output <dir>` で内部保存先を明示できますが、公開出力先およびリポジトリの `collector-data/` と重なる保存先は、取得前にエラーにします。シンボリックリンクの既存親も解決して判定します。

| ファイル | 内容 |
| --- | --- |
| `data/collector/latest.snapshot.json` | 実際に観測した全案件ID、正規URL、取得時刻、取得範囲、本文取得粒度、機械判定理由、全候補ID |
| `data/collector/latest.diff.json` | 前回資料に対する差分と取得失敗・比較不足 |
| `data/collector/snapshots/<runId>.json` | 実行単位の観測記録 |
| `data/collector/diffs/<runId>.json` | 同じ実行の差分 |
| `data/collector/latest.client-review.json` | 発注者ごとの公開業務情報、第三者評価、推論、確認事項 |
| `data/collector/client-reviews/<runId>.json` | 実行単位の発注者照合 |

run ID は取得時刻と構造化内容に基づきます。同日に別の取得を行っても履歴を上書きせず、同じ観測の再保存は元の差分を保持します。検索キーワードそのものは新しい観測記録へ保存せず、ページ・カテゴリ・プラットフォームを含む取得範囲のハッシュを保存します。「complete」は設定済み検索ページ内の正常解析を意味し、サイト全体を取得したという意味ではありません。

前回資料は内部保存先の最新 snapshot を優先し、明示した `baselinePath`、または旧 `collector-data/latest.json` を参照します。全IDがない旧 summary は比較不足のままにします。内部保存先を継続使用するローカル実行では履歴を保持します。CI の一時実行環境をまたぐ内部保存先は未接続であり、新しい runner では旧 summary 以上の前回資料がない場合があります。

workflow は追加観測をリポジトリへコピー・commit しません。公開コピーは `src/prepare-public-artifact.js` により、従来の `index.html`、`latest.json`、`latest.md`、`.nojekyll`、`archive/YYYY-MM-DD.json` だけを空の staging へ複製し、その staging を Pages artifact とします。JSON は従来フィールドだけを通し、追加フィールドを除外します。`site/collector/` に古い追加資料が残っていても公開コピーへ入りません。cron・権限・環境設定は変更していません。発注者履歴・推論の公開には別途明示承認と公開設定が必要で、この実装に公開を有効にする設定はありません。本作業では workflow を実行・公開しません。

## 差分の意味

| フィールド | 意味 |
| --- | --- |
| `added` | 前回も確認できた同じ検索範囲では不在、今回観測されたID |
| `firstObserved` | 今回観測されたが、前回の存在有無は確認できないID |
| `changed` | 同じIDの比較できる取得粒度で、内容・機械判定等に変化 |
| `comparisonInsufficient` | 詳細本文と検索要約の切替えなどで内容比較が不足 |
| `disappeared` | 前回観測した全検索範囲を今回も正常取得したが一覧にないID |
| `notObserved` | 検索失敗・範囲変更などで、前回IDを今回確認できない |
| `retrievalFailures` | 検索・詳細ごとのHTTP取得失敗または解析失敗 |

一覧からの消失は、募集終了・違反・発注者の行動を証明しません。件数一致だけでは入替えなしと判断しません。重複・矛盾・不正な参照は品質情報へ記録し、欠落を架空データで埋めません。Collector のID空間は現在の取得実装と同じ CrowdWorks 専用です。Lancers 履歴は発注者照合側で別のプラットフォームとして扱います。

旧 summary は全555件・機械候補20件の一覧を含まないため `baselineStatus: legacy_summary` とします。推薦1件を使って残りのIDを補完したり、全候補の変化を断定したりしません。

## 公開履歴の明示入力

公開履歴の自動取得は未接続です。既存の案件詳細の `JobPosting.hiringOrganization.url` に明示された CrowdWorks の公開プロフィールIDだけを関連付けます。表示名の類似や、近くにある別のHTMLリンクから発注者を推定しません。取得できた現在案件とプロフィールの対応は記録しますが、業務タグや過去履歴が不足する場合は確認不足のままです。

ローカルの取得済み公開業務資料から、以下の構造化入力を明示指定して照合できます。これはネットワークアクセスを行いません。

```powershell
node src/review-public-history.js --input public-evidence.json --output data/review.json
```

入力は履歴配列、または `{ "histories": [...] }` です。個人情報を含む原文は入力しないでください。次の例は人工データで、実在の発注者・案件の観測結果ではありません。

```json
{
  "histories": [{
    "platform": "crowdworks",
    "profileId": "123",
    "profileUrl": "https://crowdworks.jp/public/employers/123",
    "status": "insufficient_scope",
    "observedAt": "2026-10-11T02:00:00Z",
    "coverage": { "pastJobs": true, "currentJobs": true, "publicRatings": false },
    "jobs": [{
      "jobId": "456",
      "url": "https://crowdworks.jp/public/jobs/456",
      "profileId": "123",
      "visibility": "public",
      "phase": "current",
      "observedAt": "2026-10-11T02:00:00Z",
      "deliverableTags": ["data"],
      "purposeTags": ["data_processing"],
      "targetServiceTags": ["business_system"]
    }],
    "publicRatings": [],
    "relatedAccounts": []
  }]
}
```

タグは `src/client-history.js` の `BUSINESS_TAGS`、公開評価のコードは `ASSESSMENT_CODES` の固定値だけを受理します。自由文から補完しません。時系列の根拠は `observedAt` と、資料に明示されている場合の `publishedAt` / `deadlineAt` です。同じ発注者の成果物・目的・対象サービス・時系列を比較し、根拠URLと案件IDに結び付いた確認事項へ回します。

`facts`、`thirdPartyAssessments`、`inferences`、`questions` を別フィールドにします。確認事項がある場合は `safety_review_required`。疑問が検出されない場合も、違法性や安全性を自動確定しません。履歴の状態は `fetched` / `no_public_history` / `private` / `fetch_failed` / `insufficient_scope` / `not_connected` に分けます。応募済み・重複応募の管理には接続していません。

別アカウントは同じプラットフォームの `officially_declared_related_account` としてのみ記録できます。`evidence` に宣言元の正規公開プロフィールURL・ID・取得時刻・公開状態・`kind: official_relationship_statement`・`official: true` を明示してください。宣言の確認は入力者の責任で、出力にも `caller_supplied_public_statement` と記録します。同一人物という結論を出したり、別アカウントの資料を自動統合したりしません。名前・連絡先の一致を根拠にしません。

プログラムからは `runDaily({ publicHistories: [...] })`、既存の通常実行には `--public-histories <file>` を指定できます。`runDaily` 自体は従来の案件収集を行うため、本作業の検証では取得関数を人工データの関数に置き換えています。

## 規定の確認範囲と未接続箇所

2026-10-11 に [CrowdWorks 仕事依頼ガイドライン](https://crowdworks.jp/pages/guidelines/job_offer)（2025-03-14改訂表示）と [利用規約](https://crowdworks.jp/pages/agreement) を確認しました。業務禁止規定は公開履歴の自動取得許可ではありません。

[Lancers クライアントガイドライン](https://www.lancers.jp/help/safety/client_guideline) は HTTP 429 で本文未取得です。両サイトの robots.txt は使用した取得ツールの Internal Error で内容未確認でした。新たなプロフィール巡回の取得許可・範囲・アクセス規定は未確認なので、履歴取得アダプターは `automaticHistoryFetch: not_connected` / `accessPermission: unverified` のままです。ログイン、429回避、新しいアクセス、本番巡回は実施していません。

## 検証

`npm test` は Node の内蔵テストランナーだけを使用します。ネットワーク取得は保存済み資料または人工データに置き換えます。`npm run daily` は本番収集を行うため、オフライン検証として実行しないでください。テスト用出力は新規の一時ディレクトリへ隔離します。
