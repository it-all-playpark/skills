// enforceDisjointParallel: parallel task の file_changes 衝突を検出し、衝突 task を serial に降格する純粋関数。
// dev-flow の parallel fan-out 前に呼び出し、file-disjoint 制約を保証する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * normalizePath: file_changes エントリを正規化したパス文字列に変換する。
 * - ':' で分割した先頭要素を取る（'src/foo.ts: 新規作成' → 'src/foo.ts'）
 * - trim して先頭の './' を1回除去する（'./src/foo.ts' → 'src/foo.ts'、'  src/bar.ts  ' → 'src/bar.ts'）
 *
 * @param {string} s - file_changes の1エントリ
 * @returns {string} 正規化されたパス文字列
 */
export function normalizePath(s) {
  const base = s.split(':')[0].trim();
  return base.startsWith('./') ? base.slice(2) : base;
}

/**
 * enforceDisjointParallel: parallel task 群の file_changes が互いに disjoint であることを保証する。
 * 衝突する task を serial 末尾に降格（demote）して返す。
 *
 * @param {Object} plan - { summary, serial: Task[], parallel: Task[] }
 *   Task = { id, desc?, file_changes?: string[], test_plan?, depends_on? }
 * @returns {{ plan: Object, demoted: Array<{id, conflictsWith, paths}> }}
 *   plan: 元 plan を mutate せず浅いコピーしたもの（parallel = accepted のみ、serial = 元 serial + demoted）
 *   demoted: 降格した task の { id, conflictsWith: 先に accept された衝突相手の id, paths: 交差パス配列 } の配列
 */
export function enforceDisjointParallel(plan) {
  const parallelTasks = plan.parallel;

  // parallel が無い/空の場合はコピーして即返す
  if (!parallelTasks || parallelTasks.length === 0) {
    return {
      plan: { ...plan, parallel: parallelTasks ? [] : plan.parallel },
      demoted: [],
    };
  }

  // accepted task 群の正規化パス和集合（パス → 最初に accept した task id のマップ）
  const acceptedPaths = new Map(); // normalizedPath → task id
  const accepted = [];
  const demotedTasks = [];
  const demoted = [];

  for (const task of parallelTasks) {
    const taskPaths = new Set(
      (task.file_changes ?? []).map(normalizePath)
    );

    // 先行 accepted task 群との交差を検出
    const intersectingPaths = [];
    let firstConflictId = null;

    for (const p of taskPaths) {
      if (acceptedPaths.has(p)) {
        intersectingPaths.push(p);
        if (firstConflictId === null) {
          firstConflictId = acceptedPaths.get(p);
        }
      }
    }

    if (intersectingPaths.length > 0) {
      // 衝突あり → demote
      demotedTasks.push(task);
      demoted.push({
        id: task.id,
        conflictsWith: firstConflictId,
        paths: intersectingPaths,
      });
    } else {
      // 衝突なし → accept し、パスを登録
      accepted.push(task);
      for (const p of taskPaths) {
        acceptedPaths.set(p, task.id);
      }
    }
  }

  const newPlan = {
    ...plan,
    parallel: accepted,
    serial: [...(plan.serial ?? []), ...demotedTasks],
  };

  return { plan: newPlan, demoted };
}

/**
 * diffDeclaredPaths: plan の全 task の file_changes と git status の変更ファイルを突合し、
 * 宣言外の変更ファイルパスの配列を返す純粋関数。
 *
 * normalizePath を共用して表記ゆれ（'path: 説明' / './' プレフィックス / 空白）を正規化する。
 *
 * @param {Array<{id: string, file_changes?: string[]}>} planTasks - serial + parallel の全 task 配列
 * @param {string[]} changedFiles - `git status --porcelain` の変更ファイル一覧（正規化済みパスを期待する）
 * @returns {string[]} 宣言外変更ファイルパスの配列（changedFiles の正規化値が基準）
 */
export function diffDeclaredPaths(planTasks, changedFiles) {
  // plan の全 task の file_changes を正規化した宣言パス集合を構築
  const declaredSet = new Set();
  for (const task of planTasks) {
    for (const fc of (task.file_changes ?? [])) {
      declaredSet.add(normalizePath(fc));
    }
  }

  // changedFiles のうち宣言集合に含まれないものを宣言外として抽出
  const undeclared = [];
  for (const f of changedFiles) {
    const normalized = normalizePath(f);
    if (!declaredSet.has(normalized)) {
      undeclared.push(f);
    }
  }
  return undeclared;
}
