// pr-iterate.js の review 経路（decision × blocking findings）を正規化する canonical。issue #321。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// review 経路の 3 値 enum。
export const REVIEW_ROUTE_CI_GATE = 'ci_gate';
export const REVIEW_ROUTE_FIX_LOOP = 'fix_loop';
export const REVIEW_ROUTE_CONTRACT_MISMATCH = 'contract_mismatch';

// pr-reviewer の review 結果を route へ正規化する純粋関数。
//
// blocking findings の有無を一次入力、review.decision を tie-break とする:
//   - blocking.length === 0                              → REVIEW_ROUTE_CI_GATE（decision に依らず）
//   - blocking.length > 0 && decision === 'approve'       → REVIEW_ROUTE_CONTRACT_MISMATCH
//   - blocking.length > 0 && decision !== 'approve'       → REVIEW_ROUTE_FIX_LOOP
//
// blocking = severity が 'critical' または 'major' の issue（pr-iterate.js 現行の blocking 定義と同一）。
// minor = severity が 'minor' の issue。
// severity は REVIEW schema で enum ['critical','major','minor'] に制約済みのため
// out-of-enum の追加ハンドリングは入れない。
//
// review が null/undefined、review.issues が配列でない場合も throw せず空配列として扱う。
export function classifyReviewRoute(review) {
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const blocking = issues.filter((x) => x.severity === 'critical' || x.severity === 'major');
  const minor = issues.filter((x) => x.severity === 'minor');

  let route;
  if (blocking.length === 0) {
    route = REVIEW_ROUTE_CI_GATE;
  } else if (review?.decision === 'approve') {
    route = REVIEW_ROUTE_CONTRACT_MISMATCH;
  } else {
    route = REVIEW_ROUTE_FIX_LOOP;
  }

  return { route, blocking, minor };
}
