// dev-flow Final AC reconcile phase: fix 適用後の最終 PR tree に対して Analyze で freeze
// した既存 AC を one-shot で再検証するための決定論 helper 群（skip/run 判定 + ac_results
// 完全性検証）。判断（targeted evaluator の起動・prompt 構築・agent 呼び出し）は workflow
// 側が担い、本ファイルは pure 関数のみを提供する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// telemetry final_ac_reconcile の 3 値。
export const FINAL_AC_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable'];

// Final AC reconcile を実行すべきかを判定する純粋関数。
//
// 判定順（最初に該当した reason を返す）:
//   1. fixesApplied が数値でない/<=0        → no_fixes
//   2. runEval !== true                      → eval_skipped（micro path は Evaluate 0 回）
//   3. acCount が正整数でない                → no_ac（AC 0 件で agent を起動しない）
//   4. finalReconcile !== 'reverified'       → final_test_unavailable
//   5. finalTestGreen === false              → final_test_red
//   6. それ以外（true または null=no_tests） → run:true
export function shouldRunFinalAcReconcile({ fixesApplied, finalReconcile, finalTestGreen, runEval, acCount }) {
  if (typeof fixesApplied !== 'number' || !Number.isFinite(fixesApplied) || fixesApplied <= 0) {
    return { run: false, reason: 'no_fixes' };
  }
  if (runEval !== true) {
    return { run: false, reason: 'eval_skipped' };
  }
  if (!(Number.isInteger(acCount) && acCount > 0)) {
    return { run: false, reason: 'no_ac' };
  }
  if (finalReconcile !== 'reverified') {
    return { run: false, reason: 'final_test_unavailable' };
  }
  if (finalTestGreen === false) {
    return { run: false, reason: 'final_test_red' };
  }
  return { run: true, reason: 'ok' };
}

// Final AC reconcile agent の出力（ac_results 配列）を fail-closed で検証する純粋関数。
// 入力を mutate しない。
//
// 検証規則（最初に落ちた規則の reason を返す）:
//   (a) acCount が 1 以上の整数でない       → invalid_ac_count
//   (b) acResults が配列でない              → not_array
//   (c) acResults.length !== acCount        → count_mismatch
//   (d) 各要素が object でない/null         → invalid_item
//   (e) ac_index が非整数/範囲外            → index_out_of_range
//   (f) ac_index 重複                       → index_duplicate
//   (g) satisfied が boolean でない         → invalid_satisfied
//   (h) evidence が非空文字列でない         → empty_evidence
//
// 成功時は ac_index 昇順に sort した shallow copy 配列と、satisfied!==true の
// ac_index 昇順配列（unsatisfiedIndexes）を返す。
export function validateFinalAcResults(acResults, acCount) {
  if (!(Number.isInteger(acCount) && acCount >= 1)) {
    return { ok: false, reason: 'invalid_ac_count' };
  }
  if (!Array.isArray(acResults)) {
    return { ok: false, reason: 'not_array' };
  }
  if (acResults.length !== acCount) {
    return { ok: false, reason: 'count_mismatch' };
  }

  const seenIndexes = new Set();
  for (const item of acResults) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, reason: 'invalid_item' };
    }
    const { ac_index: acIndex, satisfied, evidence } = item;
    if (!(Number.isInteger(acIndex) && acIndex >= 0 && acIndex < acCount)) {
      return { ok: false, reason: 'index_out_of_range' };
    }
    if (seenIndexes.has(acIndex)) {
      return { ok: false, reason: 'index_duplicate' };
    }
    seenIndexes.add(acIndex);
    if (typeof satisfied !== 'boolean') {
      return { ok: false, reason: 'invalid_satisfied' };
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      return { ok: false, reason: 'empty_evidence' };
    }
  }

  const results = acResults
    .map((item) => ({ ...item }))
    .sort((a, b) => a.ac_index - b.ac_index);
  const unsatisfiedIndexes = results
    .filter((item) => item.satisfied !== true)
    .map((item) => item.ac_index);

  return { ok: true, results, unsatisfiedIndexes };
}
