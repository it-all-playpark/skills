// dev-flow plugin の version 定数。telemetry キー plugin_version の値として journal entry に記録する
// （issue #601）。workflow script では ${CLAUDE_PLUGIN_ROOT} が展開されず fs も使えないため、
// plugin.json を読む代わりに定数で持つ。plugin.json の version と一致することは
// _lib/plugin-version.sync.test.mjs が CI で pin する — plugin.json を上げるときは本ファイルも上げて
// tools/sync-inlines.mjs --write を実行する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const PLUGIN_VERSION = '0.3.0'
