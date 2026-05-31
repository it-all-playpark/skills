// classifyTriviality: REQ オブジェクトから trivial 判定を行う純粋関数。
// dev-flow の triviality check に使用する。
//
// INLINE COPY POLICY: .claude/workflows/dev-flow.js は dynamic workflow ローダーが
// 独自の VM コンテキストで評価するため、ESM の import 文は使用できない。
// そのため dev-flow.js に classifyTriviality の関数本体を inline コピーしており、
// _lib/triviality.sync.test.mjs がその byte 一致を CI で保証する。
// この関数を修正する際は、必ず dev-flow.js の inline コピーも同期すること。
export function classifyTriviality(req) {
  const count = req.estimated_change_file_count;
  if (typeof count !== 'number' || count < 0) {
    return { trivial: false, reason: 'estimated_change_file_count missing or invalid → safe non-trivial' };
  }
  if (count > 2) {
    return { trivial: false, reason: `estimated ${count} files > 2 → non-trivial` };
  }
  const ac = req.acceptance_criteria;
  if (!Array.isArray(ac)) {
    return { trivial: false, reason: 'acceptance_criteria missing or not array → safe non-trivial' };
  }
  if (ac.length > 3) {
    return { trivial: false, reason: `${ac.length} acceptance criteria > 3 → non-trivial` };
  }
  const validTypes = ['feat', 'fix', 'docs', 'refactor'];
  if (!validTypes.includes(req.issue_type)) {
    return { trivial: false, reason: `issue_type '${req.issue_type}' not in allowed set → non-trivial` };
  }
  const breakingPattern = /breaking|incompatible|migration|破壊的|非互換/i;
  const combined = `${req.scope ?? ''} ${req.summary ?? ''}`;
  if (breakingPattern.test(combined)) {
    return { trivial: false, reason: 'breaking change detected in scope/summary → non-trivial' };
  }
  return { trivial: true, reason: `estimated ${count} file(s), ${ac.length} AC, type=${req.issue_type}, no breaking — trivial path` };
}
