// model override を渡す call site は evaluator の 3 箇所（dev-flow.js の eval#i / final-ac-reconcile /
// security-clearance-final）と dev-improve.js の rank-judge（improve-miner）。この 1 行を変えると
// その 4 call site 全てに効く。pr-reviewer には渡さない — pr-reviewer は agents/pr-reviewer.md の
// frontmatter（opus / high）で spawn し、この定数を変えても影響しない（telemetry は
// quality_model_config = 本定数 / review_model_config = frontmatter 値で区別）。
// frontmatter 既定は opus。Fable 5 試験運用中は 'fable'、戻すときはこの 1 行を 'opus' にする。
// effort は agent() opts に記載されているが、本 harness での適用可否は未検証（受理と適用は別）。
// dev-flow-canary の opts 受理 probe（capability id: agent_opts_effort_accepted）で再判定する。
// それまで effort は frontmatter（high）固定のまま。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const QUALITY_MODEL = 'fable'
