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

// finding の file が worktree の外を指すか（issue #793）。fix agent は worktree の外に書けない（fix prompt の Boundary）ので、
// 外を指す blocking finding を fix に渡すと、fix agent が他 repo へ書きに行くか applied:false で終端する。
// 外とみなすのは: URL、`~` 始まり、`..` で worktree を出る相対パス、worktree 配下でない絶対パス。
// worktree が絶対パスでない（pr-meta が cwd を返さなかった）ときは絶対パスを判定できないので外とみなさない
// （fix に渡す側に倒す — 外とみなして黙って fix 対象から外すより、fix agent の Boundary で止める方が見える）。
export function isOutsideWorktree(file, worktree) {
  const f = typeof file === 'string' ? file.trim() : '';
  if (f === '') return false;
  if (f.includes('://')) return true;
  if (f === '~' || f.startsWith('~/')) return true;
  if (f.startsWith('/')) {
    const wt = typeof worktree === 'string' ? worktree.trim().replace(/\/+$/, '') : '';
    if (!wt.startsWith('/')) return false;
    return !(f === wt || f.startsWith(wt + '/'));
  }
  let depth = 0;
  for (const seg of f.split('/')) {
    if (seg === '..') depth -= 1;
    else if (seg !== '' && seg !== '.') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

// classifyReviewRoute の結果から worktree の外を指す blocking finding を外す。残りの blocking が 0 件なら
// route を REVIEW_ROUTE_CI_GATE に倒す（外の指摘は再 review でも消えないため、fix loop に入れると stuck か
// fix_failed で終わる）。返り値 outside は終端サマリーの人間側 follow-up に回す。
export function excludeOutsideWorktree(outcome, worktree) {
  const blocking = Array.isArray(outcome?.blocking) ? outcome.blocking : [];
  const inside = [];
  const outside = [];
  for (const f of blocking) (isOutsideWorktree(f?.file, worktree) ? outside : inside).push(f);
  if (outside.length === 0) return { outcome, outside };
  return {
    outcome: { ...outcome, blocking: inside, route: inside.length === 0 ? REVIEW_ROUTE_CI_GATE : outcome.route },
    outside,
  };
}
