import { test } from 'vitest';
import assert from 'node:assert/strict';

import { vdeltaDenies } from './vdelta-transitions.mjs';

const cleanVerdict = (over = {}) => ({
  comparability: 'exact',
  transitions: { repaired_with_test_change: [] },
  verification_surface: { status: 'intact' },
  ...over,
});

test('[vdeltaDenies] object 形式: repaired_with_test_change 非空 → deny + reasons 内容', () => {
  const res = vdeltaDenies(cleanVerdict({
    transitions: { repaired_with_test_change: ['AC-1', 'AC-2'] },
  }));
  assert.equal(res.deny, true);
  assert.equal(res.status, 'deny');
  assert.deepEqual(res.reasons, ['repaired_with_test_change(2件)']);
});

test('[vdeltaDenies] verification_surface.status=reduced → deny + reasons', () => {
  const res = vdeltaDenies(cleanVerdict({
    verification_surface: { status: 'reduced' },
  }));
  assert.equal(res.deny, true);
  assert.deepEqual(res.reasons, ['verification_surface:reduced']);
});

test('[vdeltaDenies] verification_surface.status=changed → deny + reasons', () => {
  const res = vdeltaDenies(cleanVerdict({
    verification_surface: { status: 'changed' },
  }));
  assert.equal(res.deny, true);
  assert.deepEqual(res.reasons, ['verification_surface:changed']);
});

test('[vdeltaDenies] verification_surface.status=inconclusive → deny + reasons', () => {
  const res = vdeltaDenies(cleanVerdict({
    verification_surface: { status: 'inconclusive' },
  }));
  assert.equal(res.deny, true);
  assert.deepEqual(res.reasons, ['verification_surface:inconclusive']);
});

test('[vdeltaDenies] repaired_with_test_change と verification_surface が両方成立 → reasons 2件', () => {
  const res = vdeltaDenies(cleanVerdict({
    transitions: { repaired_with_test_change: ['AC-1'] },
    verification_surface: { status: 'changed' },
  }));
  assert.equal(res.deny, true);
  assert.deepEqual(res.reasons, ['repaired_with_test_change(1件)', 'verification_surface:changed']);
});

test('[vdeltaDenies] JSON 文字列形式で同 deny', () => {
  const verdict = cleanVerdict({ transitions: { repaired_with_test_change: ['AC-1'] } });
  const res = vdeltaDenies(JSON.stringify(verdict));
  assert.equal(res.deny, true);
  assert.deepEqual(res.reasons, ['repaired_with_test_change(1件)']);
});

test('[vdeltaDenies] 不正 JSON 文字列 → fail_open・deny:false', () => {
  const res = vdeltaDenies('{not valid json');
  assert.equal(res.deny, false);
  assert.equal(res.status, 'fail_open');
  assert.deepEqual(res.reasons, []);
});

test('[vdeltaDenies] null → fail_open', () => {
  const res = vdeltaDenies(null);
  assert.equal(res.deny, false);
  assert.equal(res.status, 'fail_open');
});

test('[vdeltaDenies] undefined → fail_open', () => {
  const res = vdeltaDenies(undefined);
  assert.equal(res.deny, false);
  assert.equal(res.status, 'fail_open');
});

test('[vdeltaDenies] 非 object（number）→ fail_open', () => {
  const res = vdeltaDenies(42);
  assert.equal(res.deny, false);
  assert.equal(res.status, 'fail_open');
});

test('[vdeltaDenies] transitions 欠落 → fail_open', () => {
  const res = vdeltaDenies({ comparability: 'exact', verification_surface: { status: 'intact' } });
  assert.equal(res.deny, false);
  assert.equal(res.status, 'fail_open');
});

test('[vdeltaDenies] transitions が非 object（string）→ fail_open', () => {
  const res = vdeltaDenies({ comparability: 'exact', transitions: 'not-an-object' });
  assert.equal(res.deny, false);
  assert.equal(res.status, 'fail_open');
});

test('[vdeltaDenies] comparability≠exact（stream_changed）+ deny シグナル同時 → abstain 優先で deny:false', () => {
  const res = vdeltaDenies(cleanVerdict({
    comparability: 'stream_changed',
    transitions: { repaired_with_test_change: ['AC-1'] },
    verification_surface: { status: 'changed' },
  }));
  assert.equal(res.deny, false);
  assert.equal(res.status, 'abstain');
  assert.deepEqual(res.reasons, []);
});

test('[vdeltaDenies] comparability 欠落（≠exact 相当）→ abstain', () => {
  const res = vdeltaDenies(cleanVerdict({ comparability: undefined }));
  assert.equal(res.deny, false);
  assert.equal(res.status, 'abstain');
});

test('[vdeltaDenies] clean verdict（comparability:exact, transitions 全空, surface intact）→ clean', () => {
  const res = vdeltaDenies(cleanVerdict());
  assert.equal(res.deny, false);
  assert.equal(res.status, 'clean');
  assert.deepEqual(res.reasons, []);
});

test('[vdeltaDenies] verification_surface.status=intact → deny しない', () => {
  const res = vdeltaDenies(cleanVerdict({
    transitions: { repaired_with_test_change: [] },
    verification_surface: { status: 'intact' },
  }));
  assert.equal(res.deny, false);
  assert.equal(res.status, 'clean');
});

test('[vdeltaDenies] verification_surface 欠落は deny 理由にしない（clean）', () => {
  const res = vdeltaDenies(cleanVerdict({ verification_surface: undefined }));
  assert.equal(res.deny, false);
  assert.equal(res.status, 'clean');
});
