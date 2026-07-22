import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computeReceiptId } from './trust-digest.mjs';
import {
  TRUST_SCHEMA_VERSIONS,
  TRUST_VERDICTS,
  TRUST_RECORD_INTEGRITY,
  TRUST_REASON_CODES,
  REQUIRED_CAPABILITIES,
  TRUST_ANCHOR_KEYS,
  validateReceipt,
  checkCapabilities,
  resolveTrustLevel,
} from './trust-schema.mjs';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;

// schema_version ごとの valid receipt body（receipt_id 抜き）を作り、
// computeReceiptId で receipt_id を確定させたものを返す。
function makeValidReceipt(schemaVersion, overrides = {}) {
  const anchorsBySchema = {
    'surfaceproof/1': { source_revision: DIGEST_C, input_pack_digest: DIGEST_D },
    'evalseal/1': { base_oid: 'abc123', head_oid: 'def456', tree_oid: 'aaa111' },
    'effectdelta/1': { effect_id: 'effect-1', readback_digest: DIGEST_D },
  };
  const capabilitiesBySchema = {
    'surfaceproof/1': ['issue-read'],
    'evalseal/1': ['tree-read'],
    'effectdelta/1': ['effect-readback'],
  };
  const base = {
    schema_version: schemaVersion,
    subject: {
      kind: 'issue',
      identity: '409',
      revision_digest: DIGEST_A,
    },
    instrument: {
      adapter: 'dev-flow',
      adapter_version: '1.0.0',
      config_digest: DIGEST_B,
      capabilities: capabilitiesBySchema[schemaVersion],
    },
    outcome: {
      verdict: 'pass',
      reason_code: 'OK',
    },
    trust: {
      record_integrity: 'advisory',
    },
    anchors: anchorsBySchema[schemaVersion],
    ...overrides,
  };
  const receipt_id = computeReceiptId(base);
  return { ...base, receipt_id };
}

// ---- (1) valid receipt: 3 schema_version すべて受理される ----

for (const schemaVersion of TRUST_SCHEMA_VERSIONS) {
  test(`validateReceipt: 正規 ${schemaVersion} receipt は {ok:true, reason_code:'OK'}`, () => {
    const receipt = makeValidReceipt(schemaVersion);
    const result = validateReceipt(receipt);
    assert.deepEqual(result, { ok: true, reason_code: 'OK', detail: '' });
  });
}

// ---- (2) receipt が非 object ----

test('validateReceipt: receipt が null は SCHEMA_TYPE_MISMATCH', () => {
  const result = validateReceipt(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: receipt が配列は SCHEMA_TYPE_MISMATCH', () => {
  const result = validateReceipt([]);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: receipt が文字列は SCHEMA_TYPE_MISMATCH', () => {
  const result = validateReceipt('not-an-object');
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

// ---- (3) schema_version 不正 ----

test('validateReceipt: schema_version が未サポート値は SCHEMA_VERSION_UNSUPPORTED', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.schema_version = 'surfaceproof/2';
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_VERSION_UNSUPPORTED');
});

test('validateReceipt: schema_version 欠落は SCHEMA_VERSION_UNSUPPORTED', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  delete receipt.schema_version;
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_VERSION_UNSUPPORTED');
});

// ---- (4) top-level 未知 key / 欠落 ----

test('validateReceipt: top-level に未知 key を追加すると SCHEMA_UNKNOWN_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.extra_field = 'x';
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_FIELD');
});

test('validateReceipt: top-level の subject 欠落は SCHEMA_MISSING_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  delete receipt.subject;
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_MISSING_FIELD');
});

// ---- (5) nested object の未知 key / 欠落 / 型不一致 ----

test('validateReceipt: subject に未知 key を追加すると SCHEMA_UNKNOWN_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.subject = { ...receipt.subject, extra: 'x' };
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_FIELD');
});

test('validateReceipt: subject.identity 欠落は SCHEMA_MISSING_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  delete receipt.subject.identity;
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_MISSING_FIELD');
});

test('validateReceipt: subject.kind が空文字は SCHEMA_TYPE_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.subject.kind = '';
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: subject.kind が数値は SCHEMA_TYPE_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.subject.kind = 42;
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: instrument.capabilities が配列でないは SCHEMA_TYPE_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.instrument.capabilities = 'issue-read';
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: instrument.capabilities の要素が非文字列は SCHEMA_TYPE_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.instrument.capabilities = [1, 2];
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: outcome に未知 key を追加すると SCHEMA_UNKNOWN_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.outcome = { ...receipt.outcome, extra: 'x' };
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_FIELD');
});

test('validateReceipt: trust に未知 key を追加すると SCHEMA_UNKNOWN_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.trust = { ...receipt.trust, extra: 'x' };
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_FIELD');
});

// ---- (6) enum 違反 ----

test('validateReceipt: outcome.verdict が未知 enum ("success") は SCHEMA_UNKNOWN_ENUM', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.outcome.verdict = 'success';
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_ENUM');
});

test('validateReceipt: outcome.reason_code が未知 enum は SCHEMA_UNKNOWN_ENUM', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.outcome.reason_code = 'WHATEVER';
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_ENUM');
});

test('validateReceipt: trust.record_integrity が未知 enum は SCHEMA_UNKNOWN_ENUM', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.trust.record_integrity = 'fully-trusted';
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_ENUM');
});

// ---- (7) anchors: 他 protocol の key 混入 / 型不一致 ----

test('validateReceipt: anchors に他 protocol の key が混入すると SCHEMA_UNKNOWN_FIELD', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.anchors = { ...receipt.anchors, base_oid: 'evalseal-key-leak' };
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_UNKNOWN_FIELD');
});

test('validateReceipt: anchors の値が非文字列は SCHEMA_TYPE_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.anchors.source_revision = 12345;
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'SCHEMA_TYPE_MISMATCH');
});

test('validateReceipt: anchors が空 object でも受理される（部分集合ルール、必須キーなし）', () => {
  const receipt = makeValidReceipt('surfaceproof/1', { anchors: {} });
  const result = validateReceipt(receipt);
  assert.deepEqual(result, { ok: true, reason_code: 'OK', detail: '' });
});

// ---- (8) receipt_id 改竄 ----

test('validateReceipt: receipt_id を改竄すると RECEIPT_ID_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.receipt_id = `sha256:${'0'.repeat(64)}`;
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'RECEIPT_ID_MISMATCH');
});

test('validateReceipt: valid な evalseal receipt の schema_version を surfaceproof/1 に差し替えると receipt_id 不一致で reject（AC-2: protocol 間差し替え防止）', () => {
  const evalsealReceipt = makeValidReceipt('evalseal/1');
  // schema_version と anchors の shape だけ surfaceproof/1 に合わせ、receipt_id は
  // evalseal/1 のまま据え置く（= domain-separated digest の差し替え防止を検証する）。
  const tampered = {
    ...evalsealReceipt,
    schema_version: 'surfaceproof/1',
    anchors: { source_revision: DIGEST_C, input_pack_digest: DIGEST_D },
  };
  const result = validateReceipt(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'RECEIPT_ID_MISMATCH');
});

// ---- (9) digest 形式不正 ----

test('validateReceipt: subject.revision_digest が sha256:<hex64> 形式でないと DIGEST_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.subject.revision_digest = 'not-a-digest';
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'DIGEST_MISMATCH');
});

test('validateReceipt: instrument.config_digest が短い hex は DIGEST_MISMATCH', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.instrument.config_digest = 'sha256:abcd';
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'DIGEST_MISMATCH');
});

test('validateReceipt: revision_digest が大文字 hex は DIGEST_MISMATCH（regex は小文字固定）', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.subject.revision_digest = `sha256:${'A'.repeat(64)}`;
  receipt.receipt_id = computeReceiptId(receipt);
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'DIGEST_MISMATCH');
});

// ---- (10) checkCapabilities ----

test('checkCapabilities: capabilities が空配列は CAPABILITY_MISSING', () => {
  const receipt = makeValidReceipt('surfaceproof/1');
  receipt.instrument.capabilities = [];
  const result = checkCapabilities(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'CAPABILITY_MISSING');
  assert.deepEqual(result.missing, ['issue-read']);
});

test('checkCapabilities: 必要な capability が揃っていれば ok:true', () => {
  const receipt = makeValidReceipt('evalseal/1');
  const result = checkCapabilities(receipt);
  assert.deepEqual(result, { ok: true, reason_code: 'OK', missing: [] });
});

test('checkCapabilities: 余剰 capability があっても必要分が揃っていれば ok:true', () => {
  const receipt = makeValidReceipt('effectdelta/1');
  receipt.instrument.capabilities = ['effect-readback', 'extra-capability'];
  const result = checkCapabilities(receipt);
  assert.equal(result.ok, true);
});

test('REQUIRED_CAPABILITIES: 3 schema_version すべてに定義がある', () => {
  for (const v of TRUST_SCHEMA_VERSIONS) {
    assert.ok(Array.isArray(REQUIRED_CAPABILITIES[v]) && REQUIRED_CAPABILITIES[v].length > 0);
  }
});

// ---- (11) resolveTrustLevel ----

test('resolveTrustLevel: same-harness + tamper_evident=false は advisory', () => {
  assert.equal(resolveTrustLevel({ verifier: 'same-harness', tamper_evident: false }), 'advisory');
});

test('resolveTrustLevel: same-harness + tamper_evident=true でも advisory のまま（trusted-environment を返さない）', () => {
  assert.equal(resolveTrustLevel({ verifier: 'same-harness', tamper_evident: true }), 'advisory');
});

test('resolveTrustLevel: same-harness は如何なる入力でも trusted-environment を返さない', () => {
  assert.notEqual(resolveTrustLevel({ verifier: 'same-harness', tamper_evident: false }), 'trusted-environment');
  assert.notEqual(resolveTrustLevel({ verifier: 'same-harness', tamper_evident: true }), 'trusted-environment');
});

test('resolveTrustLevel: external-pinned + tamper_evident=true は trusted-environment', () => {
  assert.equal(resolveTrustLevel({ verifier: 'external-pinned', tamper_evident: true }), 'trusted-environment');
});

test('resolveTrustLevel: external-pinned + tamper_evident=false は tamper-evident', () => {
  assert.equal(resolveTrustLevel({ verifier: 'external-pinned', tamper_evident: false }), 'tamper-evident');
});

test('resolveTrustLevel: out-of-enum verifier は throw', () => {
  assert.throws(() => resolveTrustLevel({ verifier: 'unknown-verifier', tamper_evident: true }), /trust-schema/);
});

test('resolveTrustLevel: verifier 欠落は throw', () => {
  assert.throws(() => resolveTrustLevel({ tamper_evident: true }), /trust-schema/);
});

// ---- (12) 定数の closed enum 確認 ----

test('TRUST_SCHEMA_VERSIONS は 3 protocol', () => {
  assert.deepEqual(TRUST_SCHEMA_VERSIONS, ['surfaceproof/1', 'evalseal/1', 'effectdelta/1']);
});

test('TRUST_VERDICTS は pass/fail/inconclusive', () => {
  assert.deepEqual(TRUST_VERDICTS, ['pass', 'fail', 'inconclusive']);
});

test('TRUST_RECORD_INTEGRITY は advisory/tamper-evident/trusted-environment', () => {
  assert.deepEqual(TRUST_RECORD_INTEGRITY, ['advisory', 'tamper-evident', 'trusted-environment']);
});

test('TRUST_REASON_CODES は OK を含む closed enum', () => {
  assert.ok(TRUST_REASON_CODES.includes('OK'));
  assert.ok(TRUST_REASON_CODES.includes('CAPABILITY_MISSING'));
  assert.equal(TRUST_REASON_CODES.length, 9);
});

test('TRUST_ANCHOR_KEYS: evalseal/1 は 5 種の anchor key を許可する', () => {
  assert.deepEqual(TRUST_ANCHOR_KEYS['evalseal/1'], ['base_oid', 'head_oid', 'tree_oid', 'bundle_digest', 'evidence_digest']);
});
