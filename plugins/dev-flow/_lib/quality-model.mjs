// model override を渡す call site は dev-improve.js の rank-judge（improve-miner）のみ。この 1 行は
// その 1 call site にだけ効く。dev-flow.js / pr-iterate.js の品質ゲート agent（evaluator / pr-reviewer）は
// agents/*.md の frontmatter（opus / high）で spawn し、本定数を inline せず、model fallback 機構も持たない
// （telemetry は eval_model_config / review_model_config = frontmatter 値。一致は
// review-model-frontmatter.test.mjs が pin）。evaluator / pr-reviewer の model を変えるなら frontmatter を変える。
// rank-judge の frontmatter 既定は opus。Fable 5 試験運用中は 'fable'、戻すときはこの 1 行を 'opus' にする。
// effort は agent() opts に記載されているが、本 harness での適用可否は未検証（受理と適用は別）。
// dev-flow-canary の opts 受理 probe（capability id: agent_opts_effort_accepted）で再判定する。
// それまで effort は frontmatter（high）固定のまま。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で dev-improve.js へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const QUALITY_MODEL = 'fable'
