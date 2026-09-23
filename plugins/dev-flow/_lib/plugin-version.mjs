// dev-flow の telemetry 世代ラベル。telemetry キー plugin_version の値として journal entry に記録する
// （issue #601）。plugin.json は version を持たない（marketplace install を git commit SHA で main に
// 追随させるため。tests/plugin-manifest.bats が pin）ので、本定数は manifest から独立した集計用ラベル
// として管理する — 集計上区別したい挙動変更を入れるときに上げて tools/sync-inlines.mjs --write を
// 実行する。workflow script では ${CLAUDE_PLUGIN_ROOT} が展開されず fs も使えないため定数で持つ。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const PLUGIN_VERSION = '0.3.0'
