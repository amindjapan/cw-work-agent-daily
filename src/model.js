"use strict";

const POSITIVE_KEYWORDS = [
  "記事", "ライティング", "seo", "ブログ", "要約", "リライト", "校正", "編集",
  "文字起こし", "翻訳", "英語", "データ入力", "excel", "スプレッドシート",
  "csv", "python", "javascript", "html", "css", "wordpress", "vba", "gas",
  "スクレイピング", "リサーチ", "調査", "資料作成", "powerpoint", "chatgpt",
  "ai", "プロンプト", "notion", "json", "api"
];

const STRONG_KEYWORDS = [
  "python", "javascript", "html", "css", "csv", "json", "api", "スクレイピング",
  "要約", "リライト", "校正", "データ整理", "資料作成", "スプレッドシート"
];

const RISK_KEYWORDS = [
  "レビュー投稿", "口コミ投稿", "星5", "評価してください", "サクラ", "ステマ",
  "購入代行", "本人確認代行", "アカウント作成", "アカウント貸", "line登録",
  "外部サイト登録", "外部誘導", "コピペで稼げる", "高額商材", "投資助言",
  "fx", "暗号資産", "医療監修", "法律相談", "薬機法", "アダルト",
  "説明会", "講座", "スクール", "研修", "業務ワーク体験", "体験後に率直なご感想",
  "学ぶ意欲", "参加者を募集", "キャリアに不安", "AI使用禁止", "AI 使用禁止",
  "ChatGPT禁止", "カメラON", "DM送付", "税務", "確定申告", "在住者限定",
  "サービス外連絡", "外部連絡申請", "オンライン面談", "Zoom", "Google Meet",
  "源泉徴収", "報酬：50円", "報酬:50円", "契約金額欄に「50円」",
  "氏名（本名）", "氏名(本名)", "性別", "年間売上", "在宅ワーク環境"
];

const LOW_VALUE_KEYWORDS = [
  "テストライティング無報酬", "継続前提で低単価", "1文字0.1円", "1文字0.2円",
  "初心者歓迎のみ", "誰でもできます"
];

function normalizeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, words) {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word.toLowerCase()));
}

function parseBudgetYen(text) {
  const normalized = normalizeText(text).replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  const matches = [...normalized.matchAll(/([0-9][0-9,]{2,})\s*円/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter(Number.isFinite);
  if (!matches.length) return null;
  return Math.max(...matches);
}

function classifyJob(job) {
  const text = normalizeText([job.title, job.description, job.budget, job.category].join(" "));
  const positive = containsAny(text, POSITIVE_KEYWORDS);
  const strong = containsAny(text, STRONG_KEYWORDS);
  const risks = containsAny(text, RISK_KEYWORDS);
  const lowValue = containsAny(text, LOW_VALUE_KEYWORDS);
  const budgetYen = parseBudgetYen(text);

  let score = 35;
  score += Math.min(positive.length * 6, 30);
  score += Math.min(strong.length * 5, 20);
  if (budgetYen !== null) {
    if (budgetYen >= 5000) score += 10;
    if (budgetYen >= 20000) score += 8;
    if (budgetYen < 1000) score -= 15;
  }
  if (/急募|本日|至急|即日/.test(text)) score -= 8;
  score -= risks.length * 22;
  score -= lowValue.length * 12;
  score = Math.max(0, Math.min(100, score));

  const level = score >= 75 ? "high" : score >= 55 ? "medium" : "low";
  const verdict = risks.length
    ? "避ける"
    : score >= 65
      ? "候補"
      : score >= 45
        ? "要確認"
        : "低優先";

  return {
    score,
    level,
    verdict,
    canExecute: !risks.length && score >= 65,
    matchedSkills: [...new Set(positive)].slice(0, 10),
    strongSignals: [...new Set(strong)].slice(0, 10),
    riskFlags: [...new Set([...risks, ...lowValue])],
    budgetYen
  };
}

function makeApplyDraft(job, profile = {}) {
  const skills = (profile.skills || "文章作成、要約、リサーチ、データ整理、簡単なWeb/スクリプト作成").trim();
  const name = (profile.name || "応募者").trim();
  const timeline = (profile.timeline || "内容確認後、無理のない納期で対応します").trim();
  const title = normalizeText(job.title || "ご依頼");

  return [
    `${name}です。`,
    "",
    `「${title}」の募集内容を拝見しました。`,
    `対応可能な範囲は、${skills}です。`,
    "",
    "進め方としては、最初に目的・納品形式・参考資料・禁止事項を確認し、必要であれば小さなサンプルを共有して方向性を合わせます。",
    `納期については、${timeline}。`,
    "",
    "応募前の確認事項:",
    "- 納品形式",
    "- 文字数、件数、対象範囲",
    "- 参考資料の有無",
    "- AI利用可否と表記ルール",
    "- 修正回数の目安",
    "",
    "問題なければ、詳細を確認したうえで丁寧に対応します。よろしくお願いいたします。"
  ].join("\n");
}

function makeDeliveryDraft(job) {
  const title = normalizeText(job.title || "案件");
  return [
    `# 納品ドラフト: ${title}`,
    "",
    "## 依頼内容の確認",
    "- 目的:",
    "- 納品形式:",
    "- 対象範囲:",
    "- 禁止事項:",
    "",
    "## 作業メモ",
    "- 参照資料:",
    "- 判断に迷った点:",
    "- クライアント確認が必要な点:",
    "",
    "## 納品物",
    "ここに本文、表、コード、調査結果などを作成します。",
    "",
    "## 納品前チェック",
    "- 募集文の条件を満たした",
    "- 固有名詞と数値を確認した",
    "- 著作権・引用・AI利用ルールを確認した",
    "- ファイル名と形式を確認した"
  ].join("\n");
}

module.exports = {
  classifyJob,
  makeApplyDraft,
  makeDeliveryDraft,
  normalizeText,
  parseBudgetYen
};
