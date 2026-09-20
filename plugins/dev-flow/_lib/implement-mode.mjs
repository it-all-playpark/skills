// standard shape の Implement 経路切替（issue #668）。
//   'fable'   — Plan phase で dev-planner を起動せず issue から単一 task の plan を合成し、Implement で
//               dev-implement-fable（plan+impl 統合、frontmatter: fable / high）を 1 spawn する。
//   'planner' — 従来経路（dev-planner 1 発 → implementer を task ごとに spawn）。
// ロールバックはこの 1 行を 'planner' にして tools/sync-inlines.mjs --write するだけ（QUALITY_MODEL と同じ運用）。
// complex / micro shape は本定数に依らず現行経路のまま（plan-reviewer gate / triviality gate の扱いは別 issue）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const IMPLEMENT_MODE = 'fable'
