// 品質ゲート系 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer）の model override。
// frontmatter 既定は opus。Fable 5 試験運用中は 'fable'、戻すときはこの 1 行を 'opus' にする。
// effort は agent() opts に記載されているが、本 harness での適用可否は未検証（受理と適用は別）。
// dev-flow-canary の opts 受理 probe（capability id: agent_opts_effort_accepted）で再判定する。
// それまで effort は frontmatter（high）固定のまま。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const QUALITY_MODEL = 'fable'
