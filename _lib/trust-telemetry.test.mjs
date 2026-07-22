import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeTrustRunId, buildTrustEnvelope, formatTrustSummary } from './trust-telemetry.mjs';

// ---- (1) makeTrustRunId ----

test('makeTrustRunId: 正常入力から trust-<timestampMs>-<entropyHex> を返す', () => {
  assert.equal(
    makeTrustRunId({ timestampMs: 1753142400000, entropyHex: 'a1b2c3d4e5f6' }),
    'trust-1753142400000-a1b2c3d4e5f6',
  );
});

test('makeTrustRunId: 同一入力で反復一致する（determinism）', () => {
  const input = { timestampMs: 1753142400000, entropyHex: 'a1b2c3d4e5f6' };
  const a = makeTrustRunId(input);
  const b = makeTrustRunId(input);
  assert.equal(a, b);
});

test('makeTrustRunId: entropyHex が /^[0-9a-f]{12}$/ 不正なら throw', () => {
  assert.throws(() => makeTrustRunId({ timestampMs: 1753142400000, entropyHex: 'A1B2C3D4E5F6' }));
  assert.throws(() => makeTrustRunId({ timestampMs: 1753142400000, entropyHex: 'a1b2c3d4e5f' }));
  assert.throws(() => makeTrustRunId({ timestampMs: 1753142400000, entropyHex: 'a1b2c3d4e5f6g7' }));
  assert.throws(() => makeTrustRunId({ timestampMs: 1753142400000, entropyHex: '' }));
  assert.throws(() => makeTrustRunId({ timestampMs: 1753142400000, entropyHex: undefined }));
});

test('makeTrustRunId: timestampMs が非整数・非正なら throw', () => {
  assert.throws(() => makeTrustRunId({ timestampMs: 1753142400000.5, entropyHex: 'a1b2c3d4e5f6' }));
  assert.throws(() => makeTrustRunId({ timestampMs: 0, entropyHex: 'a1b2c3d4e5f6' }));
  assert.throws(() => makeTrustRunId({ timestampMs: -1, entropyHex: 'a1b2c3d4e5f6' }));
  assert.throws(() => makeTrustRunId({ timestampMs: '1753142400000', entropyHex: 'a1b2c3d4e5f6' }));
  assert.throws(() => makeTrustRunId({ timestampMs: NaN, entropyHex: 'a1b2c3d4e5f6' }));
});

// ---- (2) buildTrustEnvelope ----

const VALID_RUN_ID = makeTrustRunId({ timestampMs: 1753142400000, entropyHex: 'a1b2c3d4e5f6' });

function makeReceipt(overrides = {}) {
  return {
    run_id: VALID_RUN_ID,
    layer: 'surfaceproof',
    mode: 'shadow',
    receipt: {
      receipt_id: 'sha256:' + 'a'.repeat(64),
      schema_version: 'surfaceproof/1',
      subject: {
        kind: 'issue',
        identity: '409',
        revision_digest: 'sha256:' + 'b'.repeat(64),
      },
      outcome: {
        verdict: 'pass',
        reason_code: 'OK',
      },
      trust: {
        record_integrity: 'advisory',
      },
    },
    ...overrides,
  };
}

test('buildTrustEnvelope: 正常入力から固定 key 集合の envelope を返す（redaction）', () => {
  const env = buildTrustEnvelope(makeReceipt());
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      'layer',
      'mode',
      'reason_code',
      'receipt_id',
      'record_integrity',
      'revision_digest',
      'run_id',
      'schema_version',
      'subject_identity',
      'subject_kind',
      'verdict',
    ].sort(),
  );
  assert.equal(env.run_id, VALID_RUN_ID);
  assert.equal(env.layer, 'surfaceproof');
  assert.equal(env.mode, 'shadow');
  assert.equal(env.schema_version, 'surfaceproof/1');
  assert.equal(env.receipt_id, 'sha256:' + 'a'.repeat(64));
  assert.equal(env.verdict, 'pass');
  assert.equal(env.reason_code, 'OK');
  assert.equal(env.record_integrity, 'advisory');
  assert.equal(env.subject_kind, 'issue');
  assert.equal(env.subject_identity, '409');
  assert.equal(env.revision_digest, 'sha256:' + 'b'.repeat(64));
});

test('buildTrustEnvelope: raw 本文・anchors 値を含まない', () => {
  const receiptWithAnchors = makeReceipt();
  receiptWithAnchors.receipt.anchors = { source_revision: 'deadbeef', secret_body: 'should not leak' };
  const env = buildTrustEnvelope(receiptWithAnchors);
  const values = JSON.stringify(env);
  assert.equal(values.includes('should not leak'), false);
  assert.equal(values.includes('anchors'), false);
});

test('buildTrustEnvelope: layer が TELEMETRY_LAYERS 外なら throw', () => {
  assert.throws(() => buildTrustEnvelope(makeReceipt({ layer: 'unknownlayer' })));
});

test('buildTrustEnvelope: mode が TELEMETRY_MODES 外なら throw', () => {
  assert.throws(() => buildTrustEnvelope(makeReceipt({ mode: 'unknownmode' })));
});

test('buildTrustEnvelope: run_id が makeTrustRunId 形式外なら throw', () => {
  assert.throws(() => buildTrustEnvelope(makeReceipt({ run_id: 'not-a-run-id' })));
});

test('buildTrustEnvelope: verdict が closed enum 外なら throw', () => {
  const receipt = makeReceipt();
  receipt.receipt.outcome.verdict = 'maybe';
  assert.throws(() => buildTrustEnvelope(receipt));
});

test('buildTrustEnvelope: reason_code が closed enum 外なら throw', () => {
  const receipt = makeReceipt();
  receipt.receipt.outcome.reason_code = 'WHATEVER';
  assert.throws(() => buildTrustEnvelope(receipt));
});

test('buildTrustEnvelope: record_integrity が closed enum 外なら throw', () => {
  const receipt = makeReceipt();
  receipt.receipt.trust.record_integrity = 'super-trusted';
  assert.throws(() => buildTrustEnvelope(receipt));
});

// ---- (3) formatTrustSummary ----

test('formatTrustSummary: 空配列は空文字を返す', () => {
  assert.equal(formatTrustSummary([]), '');
});

test('formatTrustSummary: 全 envelope が mode==="off" なら空文字を返す', () => {
  const env1 = buildTrustEnvelope(makeReceipt({ mode: 'off' }));
  const env2 = buildTrustEnvelope(
    makeReceipt({
      layer: 'evalseal',
      mode: 'off',
      receipt: {
        receipt_id: 'sha256:' + 'c'.repeat(64),
        schema_version: 'evalseal/1',
        subject: { kind: 'pr', identity: '410', revision_digest: 'sha256:' + 'd'.repeat(64) },
        outcome: { verdict: 'fail', reason_code: 'OK' },
        trust: { record_integrity: 'tamper-evident' },
      },
    }),
  );
  assert.equal(formatTrustSummary([env1, env2]), '');
});

test('formatTrustSummary: 非空時は見出しと layer 行を含む', () => {
  const env = buildTrustEnvelope(makeReceipt());
  const out = formatTrustSummary([env]);
  assert.match(out, /^### Trust receipts \(shadow\)/);
  assert.match(out, /- surfaceproof \[shadow\]: VERIFIED \(OK\) subject=issue:409/);
});

test('formatTrustSummary: verdict → STATUS 写像 pass/fail/inconclusive', () => {
  const passEnv = buildTrustEnvelope(makeReceipt());
  const failEnv = buildTrustEnvelope(
    makeReceipt({
      layer: 'evalseal',
      receipt: {
        receipt_id: 'sha256:' + 'c'.repeat(64),
        schema_version: 'evalseal/1',
        subject: { kind: 'pr', identity: '410', revision_digest: 'sha256:' + 'd'.repeat(64) },
        outcome: { verdict: 'fail', reason_code: 'OK' },
        trust: { record_integrity: 'tamper-evident' },
      },
    }),
  );
  const inconclusiveEnv = buildTrustEnvelope(
    makeReceipt({
      layer: 'effectdelta',
      receipt: {
        receipt_id: 'sha256:' + 'e'.repeat(64),
        schema_version: 'effectdelta/1',
        subject: { kind: 'pr', identity: '411', revision_digest: 'sha256:' + 'f'.repeat(64) },
        outcome: { verdict: 'inconclusive', reason_code: 'CAPABILITY_MISSING' },
        trust: { record_integrity: 'advisory' },
      },
    }),
  );
  const out = formatTrustSummary([passEnv, failEnv, inconclusiveEnv]);
  assert.match(out, /VERIFIED \(OK\) subject=issue:409/);
  assert.match(out, /HOLD \(OK\) subject=pr:410/);
  assert.match(out, /INCONCLUSIVE \(CAPABILITY_MISSING\) subject=pr:411/);
});

test('formatTrustSummary: receipt_id / revision_digest は <details><summary>digests</summary> 内にある', () => {
  const env = buildTrustEnvelope(makeReceipt());
  const out = formatTrustSummary([env]);
  assert.match(out, /<details><summary>digests<\/summary>/);
  const detailsIdx = out.indexOf('<details>');
  const receiptIdIdx = out.indexOf(env.receipt_id);
  const revisionDigestIdx = out.lastIndexOf(env.revision_digest);
  assert.ok(detailsIdx >= 0 && receiptIdIdx > detailsIdx);
  assert.ok(revisionDigestIdx > detailsIdx);
  // STATUS 行自体には receipt_id / revision_digest が含まれない（常時可視部分から除外）
  const statusLine = out.split('\n').find((l) => l.startsWith('- surfaceproof'));
  assert.ok(statusLine);
  assert.equal(statusLine.includes(env.receipt_id), false);
});
