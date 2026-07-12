import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINAL_AC_RECONCILE_VALUES,
  shouldRunFinalAcReconcile,
  validateFinalAcResults,
} from './final-ac-reconcile.mjs';

// ---- (1) FINAL_AC_RECONCILE_VALUES ----

test('FINAL_AC_RECONCILE_VALUES は skipped/reverified/unavailable の 3 値配列', () => {
  assert.deepEqual(FINAL_AC_RECONCILE_VALUES, ['skipped', 'reverified', 'unavailable']);
});

// ---- (2) shouldRunFinalAcReconcile ----

test('shouldRunFinalAcReconcile: fixesApplied=0 → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 0,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: fixesApplied が数値でない → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: null,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: fixesApplied が負数 → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: -1,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: runEval !== true → eval_skipped (micro path)', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: false,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'eval_skipped' });
});

test('shouldRunFinalAcReconcile: acCount=0 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 0,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount が非整数 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 1.5,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount が負数 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: -2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount=2 + finalReconcile=unavailable → final_test_unavailable', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'unavailable',
    finalTestGreen: null,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' });
});

test('shouldRunFinalAcReconcile: finalReconcile=skipped → final_test_unavailable', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'skipped',
    finalTestGreen: null,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=false → final_test_red', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: false,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_red' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=null(no_tests) + reverified → run:true', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: null,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=true → run:true', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 1,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 5,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
});

// ---- (3) validateFinalAcResults ----

test('validateFinalAcResults: 正常 2 件（順不同入力が sort されて返る + unsatisfiedIndexes 抽出）', () => {
  const input = [
    { ac_index: 1, satisfied: false, evidence: 'not satisfied' },
    { ac_index: 0, satisfied: true, evidence: 'satisfied fully' },
  ];
  const result = validateFinalAcResults(input, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [
    { ac_index: 0, satisfied: true, evidence: 'satisfied fully' },
    { ac_index: 1, satisfied: false, evidence: 'not satisfied' },
  ]);
  assert.deepEqual(result.unsatisfiedIndexes, [1]);
});

test('validateFinalAcResults: 入力配列を mutate しない', () => {
  const input = [
    { ac_index: 1, satisfied: false, evidence: 'not satisfied' },
    { ac_index: 0, satisfied: true, evidence: 'satisfied fully' },
  ];
  const inputCopy = JSON.parse(JSON.stringify(input));
  validateFinalAcResults(input, 2);
  assert.deepEqual(input, inputCopy);
});

test('validateFinalAcResults: acResults=null → not_array', () => {
  const result = validateFinalAcResults(null, 2);
  assert.deepEqual(result, { ok: false, reason: 'not_array' });
});

test('validateFinalAcResults: acResults がオブジェクト → not_array', () => {
  const result = validateFinalAcResults({}, 2);
  assert.deepEqual(result, { ok: false, reason: 'not_array' });
});

test('validateFinalAcResults: 件数不足 → count_mismatch', () => {
  const result = validateFinalAcResults(
    [{ ac_index: 0, satisfied: true, evidence: 'ok' }],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'count_mismatch' });
});

test('validateFinalAcResults: 件数過剰 → count_mismatch', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
      { ac_index: 2, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'count_mismatch' });
});

test('validateFinalAcResults: 要素が object でない → invalid_item', () => {
  const result = validateFinalAcResults(['not-an-object', { ac_index: 1, satisfied: true, evidence: 'ok' }], 2);
  assert.deepEqual(result, { ok: false, reason: 'invalid_item' });
});

test('validateFinalAcResults: 要素が null → invalid_item', () => {
  const result = validateFinalAcResults([null, { ac_index: 1, satisfied: true, evidence: 'ok' }], 2);
  assert.deepEqual(result, { ok: false, reason: 'invalid_item' });
});

test('validateFinalAcResults: ac_index が非整数 → index_out_of_range', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0.5, satisfied: true, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_out_of_range' });
});

test('validateFinalAcResults: ac_index が負数 → index_out_of_range', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: -1, satisfied: true, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_out_of_range' });
});

test('validateFinalAcResults: ac_index が acCount 以上 → index_out_of_range', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'ok' },
      { ac_index: 2, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_out_of_range' });
});

test('validateFinalAcResults: ac_index 重複 → index_duplicate', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'ok' },
      { ac_index: 0, satisfied: false, evidence: 'dup' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_duplicate' });
});

test('validateFinalAcResults: satisfied 欠落 → invalid_satisfied', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid_satisfied' });
});

test('validateFinalAcResults: satisfied が boolean でない → invalid_satisfied', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: 'true', evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid_satisfied' });
});

test('validateFinalAcResults: evidence 空文字 → empty_evidence', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: '' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: evidence 空白のみ → empty_evidence', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: '   ' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: evidence 欠落（非string）→ empty_evidence', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: false },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: satisfied=false でも evidence 必須（空だと empty_evidence）', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: false, evidence: '' },
    ],
    1,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: acCount=0 → invalid_ac_count', () => {
  const result = validateFinalAcResults([], 0);
  assert.deepEqual(result, { ok: false, reason: 'invalid_ac_count' });
});

test('validateFinalAcResults: acCount が非整数 → invalid_ac_count', () => {
  const result = validateFinalAcResults(
    [{ ac_index: 0, satisfied: true, evidence: 'ok' }],
    1.5,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid_ac_count' });
});

test('validateFinalAcResults: acCount が負数 → invalid_ac_count', () => {
  const result = validateFinalAcResults([], -1);
  assert.deepEqual(result, { ok: false, reason: 'invalid_ac_count' });
});

test('validateFinalAcResults: 全件 satisfied:true → unsatisfiedIndexes は空配列', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'a' },
      { ac_index: 1, satisfied: true, evidence: 'b' },
      { ac_index: 2, satisfied: true, evidence: 'c' },
    ],
    3,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.unsatisfiedIndexes, []);
});
