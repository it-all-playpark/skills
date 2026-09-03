import { test } from 'vitest';
import assert from 'node:assert/strict';

import { vdeltaDenies, vdeltaVerdictDigest } from './vdelta-transitions.mjs';

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

test('[vdeltaVerdictDigest] object verdict → 閉じた 4 キー digest', () => {
  const verdict = cleanVerdict({
    transitions: { repaired_with_test_change: ['AC-1', 'AC-2'] },
  });
  const digest = vdeltaVerdictDigest(verdict);
  assert.deepEqual(digest, {
    status: 'deny',
    comparability: 'exact',
    verification_surface: 'intact',
    repaired_with_test_change: 2,
  });
});

test('[vdeltaVerdictDigest] JSON 文字列 verdict でも同結果', () => {
  const verdict = cleanVerdict({
    transitions: { repaired_with_test_change: ['AC-1', 'AC-2'] },
  });
  const digest = vdeltaVerdictDigest(JSON.stringify(verdict));
  assert.deepEqual(digest, {
    status: 'deny',
    comparability: 'exact',
    verification_surface: 'intact',
    repaired_with_test_change: 2,
  });
});

test('[vdeltaVerdictDigest] 不正 JSON 文字列 → fail_open + fields null/0', () => {
  const digest = vdeltaVerdictDigest('not-json{');
  assert.deepEqual(digest, {
    status: 'fail_open',
    comparability: null,
    verification_surface: null,
    repaired_with_test_change: 0,
  });
});

test('[vdeltaVerdictDigest] comparability≠exact → status:abstain', () => {
  const digest = vdeltaVerdictDigest(cleanVerdict({ comparability: 'stream_changed' }));
  assert.equal(digest.status, 'abstain');
  assert.equal(digest.comparability, 'stream_changed');
});

test('[vdeltaVerdictDigest] redaction 回帰: 日本語テスト名・vdelta show --raw anchor を含む raw verdict でも digest に漏れない', () => {
  const rawVerdict = {
    comparability: 'exact',
    verification_surface: { status: 'intact' },
    transitions: {
      repaired_with_test_change: ['AC-1'],
      updated_fail: [
        {
          test_name: '日本語のテスト名：異常系がエスケープされた文字列を含む場合の挙動確認',
          anchor: 'vdelta show run_devflow-411 --raw',
          run_id: 'devflow-411',
          nested: '{"escaped":"\\\\n\\\\t\\"quoted\\"\\\\u0041"}',
        },
      ],
    },
  };
  const digest = vdeltaVerdictDigest(rawVerdict);
  const serialized = JSON.stringify(digest);
  assert.ok(!serialized.includes('日本語'));
  assert.ok(!serialized.includes('vdelta show'));
  assert.ok(!serialized.includes('devflow-411'));
  assert.ok(!serialized.includes('escaped'));
  assert.ok(serialized.length < 300, `digest serialized length should be < 300 bytes, got ${serialized.length}`);
});

test('[vdeltaVerdictDigest] 64 文字超の comparability は slice(0,64) される', () => {
  const longComparability = 'x'.repeat(100);
  const digest = vdeltaVerdictDigest(cleanVerdict({ comparability: longComparability }));
  assert.equal(digest.comparability, 'x'.repeat(64));
  assert.equal(digest.comparability.length, 64);
});

test('[vdeltaVerdictDigest] verification_surface.status 欠落 → null', () => {
  const digest = vdeltaVerdictDigest(cleanVerdict({ verification_surface: undefined }));
  assert.equal(digest.verification_surface, null);
});

test('[vdeltaVerdictDigest] transitions.repaired_with_test_change が配列でない → 0', () => {
  const digest = vdeltaVerdictDigest(cleanVerdict({ transitions: { repaired_with_test_change: 'not-an-array' } }));
  assert.equal(digest.repaired_with_test_change, 0);
});

test('[vdeltaVerdictDigest] null verdict → fail_open + fields null/0', () => {
  const digest = vdeltaVerdictDigest(null);
  assert.deepEqual(digest, {
    status: 'fail_open',
    comparability: null,
    verification_surface: null,
    repaired_with_test_change: 0,
  });
});
