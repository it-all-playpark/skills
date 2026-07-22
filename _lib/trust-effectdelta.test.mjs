// issue #412 (#390 Phase 4): EffectDelta pure core の unit test。
// vitest + node:assert/strict（_lib/trust-surfaceproof.test.mjs のスタイルを踏襲）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { domainSeparatedDigest, sha256Hex } from './trust-digest.mjs';
import { validateReceipt } from './trust-schema.mjs';
import {
  EFFECTDELTA_OBSERVATIONS,
  EFFECTDELTA_REASON_CODES,
  derivePrEffectId,
  deriveCommentEffectId,
  commentMarker,
  classifyPrObservation,
  classifyCommentObservation,
  observationToOutcome,
  buildEffectDeltaReceipt,
} from './trust-effectdelta.mjs';

const SAMPLE_BODY_DIGEST = sha256Hex('summary comment body');

// ---- constants ----

test('EFFECTDELTA constants are closed enums with expected shape', () => {
  assert.deepEqual(EFFECTDELTA_OBSERVATIONS, ['observed', 'mismatch', 'inconclusive']);
  assert.deepEqual(EFFECTDELTA_REASON_CODES, [
    'OK',
    'DUPLICATE_EFFECT',
    'WRONG_TARGET',
    'RESPONSE_LOST',
    'TARGET_MISSING',
    'PROBE_FAILED',
  ]);
});

// ---- derivePrEffectId ----

test('derivePrEffectId: 同一入力は決定論的に同一 digest', () => {
  const input = { repo: 'it-all-playpark/skills', issue: 412, base: 'main', head_oid: 'abc123' };
  assert.equal(derivePrEffectId(input), derivePrEffectId({ ...input }));
});

test('derivePrEffectId: effectdelta/pr/1 domain の domainSeparatedDigest と一致する', () => {
  const payload = { repo: 'it-all-playpark/skills', issue: 412, base: 'main', head_oid: 'abc123' };
  assert.equal(derivePrEffectId(payload), domainSeparatedDigest('effectdelta/pr/1', payload));
});

test('derivePrEffectId: domain 分離 — 同一 payload でも別 domain とは digest が異なる', () => {
  const payload = { repo: 'it-all-playpark/skills', issue: 412, base: 'main', head_oid: 'abc123' };
  const prDigest = domainSeparatedDigest('effectdelta/pr/1', payload);
  const commentDigest = domainSeparatedDigest('effectdelta/comment/1', payload);
  const journalDigest = domainSeparatedDigest('effectdelta/journal/1', payload);
  assert.notEqual(prDigest, commentDigest);
  assert.notEqual(prDigest, journalDigest);
  assert.notEqual(commentDigest, journalDigest);
});

test('derivePrEffectId: issue は number も許可する', () => {
  assert.doesNotThrow(() => derivePrEffectId({ repo: 'org/repo', issue: 1, base: 'main', head_oid: 'a'.repeat(40) }));
});

test('derivePrEffectId: 必須引数の欠落は throw', () => {
  assert.throws(() => derivePrEffectId({ issue: 1, base: 'main', head_oid: 'x' }), /repo/);
  assert.throws(() => derivePrEffectId({ repo: 'org/repo', base: 'main', head_oid: 'x' }), /issue/);
  assert.throws(() => derivePrEffectId({ repo: 'org/repo', issue: 1, head_oid: 'x' }), /base/);
  assert.throws(() => derivePrEffectId({ repo: 'org/repo', issue: 1, base: 'main' }), /head_oid/);
});

test('derivePrEffectId: 非文字列 repo/base/head_oid は throw', () => {
  assert.throws(() => derivePrEffectId({ repo: 1, issue: 1, base: 'main', head_oid: 'x' }));
  assert.throws(() => derivePrEffectId({ repo: 'org/repo', issue: 1, base: 1, head_oid: 'x' }));
  assert.throws(() => derivePrEffectId({ repo: 'org/repo', issue: 1, base: 'main', head_oid: 1 }));
});

// ---- deriveCommentEffectId ----

test('deriveCommentEffectId: 同一入力は決定論的に同一 digest', () => {
  const input = { repo: 'org/repo', pr: 5, effect_type: 'summary-comment', run_id: 'run-1', body_digest: SAMPLE_BODY_DIGEST };
  assert.equal(deriveCommentEffectId(input), deriveCommentEffectId({ ...input }));
});

test('deriveCommentEffectId: effectdelta/comment/1 domain の domainSeparatedDigest と一致する', () => {
  const payload = { repo: 'org/repo', pr: 5, effect_type: 'summary-comment', run_id: 'run-1', body_digest: SAMPLE_BODY_DIGEST };
  assert.equal(deriveCommentEffectId(payload), domainSeparatedDigest('effectdelta/comment/1', payload));
});

test('deriveCommentEffectId: body_digest が sha256:<hex64> 形式でなければ throw', () => {
  assert.throws(
    () => deriveCommentEffectId({ repo: 'org/repo', pr: 5, effect_type: 'x', run_id: 1, body_digest: 'not-a-digest' }),
    /body_digest/,
  );
  assert.throws(
    () => deriveCommentEffectId({ repo: 'org/repo', pr: 5, effect_type: 'x', run_id: 1, body_digest: 'sha256:short' }),
    /body_digest/,
  );
});

test('deriveCommentEffectId: 必須引数の欠落は throw', () => {
  assert.throws(() => deriveCommentEffectId({ pr: 5, effect_type: 'x', run_id: 1, body_digest: SAMPLE_BODY_DIGEST }), /repo/);
  assert.throws(() => deriveCommentEffectId({ repo: 'org/repo', effect_type: 'x', run_id: 1, body_digest: SAMPLE_BODY_DIGEST }), /pr/);
  assert.throws(() => deriveCommentEffectId({ repo: 'org/repo', pr: 5, run_id: 1, body_digest: SAMPLE_BODY_DIGEST }), /effect_type/);
  assert.throws(() => deriveCommentEffectId({ repo: 'org/repo', pr: 5, effect_type: 'x', body_digest: SAMPLE_BODY_DIGEST }), /run_id/);
});

// ---- commentMarker ----

test('commentMarker: HTML comment 形式で effectId を埋め込む', () => {
  const effectId = 'sha256:' + 'a'.repeat(64);
  assert.equal(commentMarker(effectId), `<!-- devflow-effect: ${effectId} -->`);
});

test('commentMarker: 非文字列/空文字は throw', () => {
  assert.throws(() => commentMarker(''));
  assert.throws(() => commentMarker(undefined));
  assert.throws(() => commentMarker(123));
});

// ---- classifyPrObservation ----

const INTENDED = { repo: 'org/repo', base: 'main', head_oid: 'abc123' };
const OPEN_MATCH = { number: 1, url: 'https://github.com/org/repo/pull/1', baseRefName: 'main', headRefOid: 'abc123', state: 'OPEN' };
const OPEN_MATCH_2 = { number: 2, url: 'https://github.com/org/repo/pull/2', baseRefName: 'main', headRefOid: 'abc123', state: 'OPEN' };
const OTHER_PR = { number: 3, url: 'https://github.com/org/repo/pull/3', baseRefName: 'develop', headRefOid: 'zzz999', state: 'OPEN' };

test('classifyPrObservation (a): readback一致 + candidates中1件 → observed/OK', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: [OPEN_MATCH], readback: OPEN_MATCH });
  assert.deepEqual(result, { status: 'observed', reason_code: 'OK' });
});

test('classifyPrObservation (b): 該当 open PR が2件以上 → mismatch/DUPLICATE_EFFECT', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: [OPEN_MATCH, OPEN_MATCH_2], readback: OPEN_MATCH });
  assert.deepEqual(result, { status: 'mismatch', reason_code: 'DUPLICATE_EFFECT' });
});

test('classifyPrObservation (c): readback ありだが base/head/state 不一致 → mismatch/WRONG_TARGET', () => {
  const wrongState = { ...OPEN_MATCH, state: 'CLOSED' };
  const result = classifyPrObservation({ intended: INTENDED, candidates: [], readback: wrongState });
  assert.deepEqual(result, { status: 'mismatch', reason_code: 'WRONG_TARGET' });
});

test('classifyPrObservation (c): readback の base 不一致 → mismatch/WRONG_TARGET', () => {
  const wrongBase = { ...OPEN_MATCH, baseRefName: 'develop' };
  const result = classifyPrObservation({ intended: INTENDED, candidates: [OPEN_MATCH], readback: wrongBase });
  assert.deepEqual(result, { status: 'mismatch', reason_code: 'WRONG_TARGET' });
});

test('classifyPrObservation (d): responseLost かつ rediscovery 空 → inconclusive/RESPONSE_LOST', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: [], readback: null, responseLost: true });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'RESPONSE_LOST' });
});

test('classifyPrObservation (d): responseLost かつ candidates=null → inconclusive/RESPONSE_LOST', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: null, readback: null, responseLost: true });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'RESPONSE_LOST' });
});

test('classifyPrObservation (e): listing 自体が失敗(candidates=null)・responseLostでない → inconclusive/PROBE_FAILED', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: null, readback: null, responseLost: false });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'PROBE_FAILED' });
});

test('classifyPrObservation (f): listing 成功しゼロ件・readback null（作成前探索文脈） → inconclusive/TARGET_MISSING', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: [], readback: null, responseLost: false });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'TARGET_MISSING' });
});

test('classifyPrObservation: 無関係 PR が candidates にあってもマッチ数に含めない', () => {
  const result = classifyPrObservation({ intended: INTENDED, candidates: [OTHER_PR], readback: null });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'TARGET_MISSING' });
});

test('classifyPrObservation: intended 欠落は throw', () => {
  assert.throws(() => classifyPrObservation({ candidates: [], readback: null }));
  assert.throws(() => classifyPrObservation({ intended: { base: 'main' }, candidates: [], readback: null }));
});

test('classifyPrObservation: candidates/readback の型不正は throw', () => {
  assert.throws(() => classifyPrObservation({ intended: INTENDED, candidates: 'nope', readback: null }));
  assert.throws(() => classifyPrObservation({ intended: INTENDED, candidates: [], readback: 'nope' }));
});

// ---- classifyCommentObservation ----

const EXPECTED_DIGEST = SAMPLE_BODY_DIGEST;
const MATCHED_ENTRY = { id: 100, body_digest: EXPECTED_DIGEST, author: 'github-actions[bot]', pr: 5 };
const MATCHED_ENTRY_2 = { id: 101, body_digest: EXPECTED_DIGEST, author: 'github-actions[bot]', pr: 5 };

test('classifyCommentObservation: exactly-1 + readback一致 → observed/OK', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [MATCHED_ENTRY],
    readback: MATCHED_ENTRY,
  });
  assert.deepEqual(result, { status: 'observed', reason_code: 'OK' });
});

test('classifyCommentObservation: preexisting=true で1件発見（今回投稿せず） → observed/DUPLICATE_EFFECT', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [MATCHED_ENTRY],
    readback: null,
    preexisting: true,
  });
  assert.deepEqual(result, { status: 'observed', reason_code: 'DUPLICATE_EFFECT' });
});

test('classifyCommentObservation: 2件以上 → mismatch/DUPLICATE_EFFECT', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [MATCHED_ENTRY, MATCHED_ENTRY_2],
    readback: MATCHED_ENTRY,
  });
  assert.deepEqual(result, { status: 'mismatch', reason_code: 'DUPLICATE_EFFECT' });
});

test('classifyCommentObservation: digest 不一致 → mismatch/WRONG_TARGET', () => {
  const wrongDigest = { ...MATCHED_ENTRY, body_digest: sha256Hex('different body') };
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [MATCHED_ENTRY],
    readback: wrongDigest,
  });
  assert.deepEqual(result, { status: 'mismatch', reason_code: 'WRONG_TARGET' });
});

test('classifyCommentObservation: author 不一致 → mismatch/WRONG_TARGET', () => {
  const wrongAuthor = { ...MATCHED_ENTRY, author: 'someone-else' };
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [MATCHED_ENTRY],
    readback: wrongAuthor,
  });
  assert.deepEqual(result, { status: 'mismatch', reason_code: 'WRONG_TARGET' });
});

test('classifyCommentObservation: responseLost かつ rediscovery 空 → inconclusive/RESPONSE_LOST', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [],
    readback: null,
    responseLost: true,
  });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'RESPONSE_LOST' });
});

test('classifyCommentObservation: marker 検索自体が失敗(matches=null) → inconclusive/PROBE_FAILED', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: null,
    readback: null,
  });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'PROBE_FAILED' });
});

test('classifyCommentObservation: matched はあるが readback 未取得 → inconclusive/PROBE_FAILED', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [MATCHED_ENTRY],
    readback: null,
  });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'PROBE_FAILED' });
});

test('classifyCommentObservation: marker 検索成功しゼロ件・responseLostでない → inconclusive/PROBE_FAILED', () => {
  const result = classifyCommentObservation({
    effect_id: 'sha256:' + 'a'.repeat(64),
    expected_body_digest: EXPECTED_DIGEST,
    matches: [],
    readback: null,
  });
  assert.deepEqual(result, { status: 'inconclusive', reason_code: 'PROBE_FAILED' });
});

test('classifyCommentObservation: expected_body_digest 不正形式は throw', () => {
  assert.throws(() =>
    classifyCommentObservation({
      effect_id: 'sha256:' + 'a'.repeat(64),
      expected_body_digest: 'not-a-digest',
      matches: [],
      readback: null,
    }),
  );
});

// ---- observationToOutcome ----

test('observationToOutcome: observed → pass/OK', () => {
  assert.deepEqual(observationToOutcome('observed'), { verdict: 'pass', reason_code: 'OK' });
});

test('observationToOutcome: mismatch → fail/DIGEST_MISMATCH', () => {
  assert.deepEqual(observationToOutcome('mismatch'), { verdict: 'fail', reason_code: 'DIGEST_MISMATCH' });
});

test('observationToOutcome: inconclusive → inconclusive/CAPABILITY_MISSING', () => {
  assert.deepEqual(observationToOutcome('inconclusive'), { verdict: 'inconclusive', reason_code: 'CAPABILITY_MISSING' });
});

test('observationToOutcome: out-of-enum は throw', () => {
  assert.throws(() => observationToOutcome('unknown-status'));
});

// ---- buildEffectDeltaReceipt ----

function assertValidReceipt(receipt) {
  const v = validateReceipt(receipt);
  assert.deepEqual(v, { ok: true, reason_code: 'OK', detail: '' });
}

test('buildEffectDeltaReceipt: observed status → validateReceipt ok:true, record_integrity=advisory', () => {
  const effectId = derivePrEffectId({ repo: 'org/repo', issue: 1, base: 'main', head_oid: 'a'.repeat(40) });
  const readbackDigest = sha256Hex('pr readback state');
  const receipt = buildEffectDeltaReceipt({
    effect_id: effectId,
    readback_digest: readbackDigest,
    subject_identity: 'org/repo#pr-1',
    status: 'observed',
    config: { adapter: 'gh-cli' },
  });
  assertValidReceipt(receipt);
  assert.equal(receipt.schema_version, 'effectdelta/1');
  assert.equal(receipt.trust.record_integrity, 'advisory');
  assert.equal(receipt.outcome.verdict, 'pass');
  assert.equal(receipt.anchors.effect_id, effectId);
  assert.equal(receipt.anchors.readback_digest, readbackDigest);
  assert.equal(receipt.subject.revision_digest, readbackDigest);
});

test('buildEffectDeltaReceipt: mismatch status → outcome.verdict=fail', () => {
  const effectId = derivePrEffectId({ repo: 'org/repo', issue: 1, base: 'main', head_oid: 'a'.repeat(40) });
  const receipt = buildEffectDeltaReceipt({
    effect_id: effectId,
    readback_digest: sha256Hex('mismatched state'),
    subject_identity: 'org/repo#pr-1',
    status: 'mismatch',
    config: {},
  });
  assertValidReceipt(receipt);
  assert.equal(receipt.outcome.verdict, 'fail');
  assert.equal(receipt.outcome.reason_code, 'DIGEST_MISMATCH');
});

test('buildEffectDeltaReceipt: inconclusive かつ readback_digest 省略 → anchors から欠落しない固定値を使う', () => {
  const effectId = derivePrEffectId({ repo: 'org/repo', issue: 1, base: 'main', head_oid: 'a'.repeat(40) });
  const receipt = buildEffectDeltaReceipt({
    effect_id: effectId,
    subject_identity: 'org/repo#pr-1',
    status: 'inconclusive',
    config: {},
  });
  assertValidReceipt(receipt);
  assert.equal(receipt.outcome.verdict, 'inconclusive');
  assert.equal(receipt.anchors.readback_digest, sha256Hex('effectdelta/no-readback'));
  assert.equal(receipt.subject.revision_digest, sha256Hex('effectdelta/no-readback'));
});

test('buildEffectDeltaReceipt: receipt_id は computeReceiptId(receipt) と一致する（validateReceipt (g) が担保）', () => {
  const effectId = derivePrEffectId({ repo: 'org/repo', issue: 2, base: 'main', head_oid: 'b'.repeat(40) });
  const receipt = buildEffectDeltaReceipt({
    effect_id: effectId,
    readback_digest: sha256Hex('state'),
    subject_identity: 'org/repo#pr-2',
    status: 'observed',
    config: { x: 1 },
  });
  assertValidReceipt(receipt);
});

test('buildEffectDeltaReceipt: 同一入力は決定論的に同一 receipt_id', () => {
  const args = {
    effect_id: derivePrEffectId({ repo: 'org/repo', issue: 3, base: 'main', head_oid: 'c'.repeat(40) }),
    readback_digest: sha256Hex('state-3'),
    subject_identity: 'org/repo#pr-3',
    status: 'observed',
    config: { x: 1 },
  };
  const r1 = buildEffectDeltaReceipt(args);
  const r2 = buildEffectDeltaReceipt({ ...args });
  assert.equal(r1.receipt_id, r2.receipt_id);
});

test('buildEffectDeltaReceipt: status out-of-enum は throw', () => {
  assert.throws(() =>
    buildEffectDeltaReceipt({
      effect_id: 'sha256:' + 'a'.repeat(64),
      subject_identity: 'org/repo#pr-1',
      status: 'unknown',
      config: {},
    }),
  );
});

test('buildEffectDeltaReceipt: 必須引数の欠落は throw', () => {
  assert.throws(() => buildEffectDeltaReceipt({ subject_identity: 'x', status: 'observed', config: {} }));
  assert.throws(() => buildEffectDeltaReceipt({ effect_id: 'sha256:' + 'a'.repeat(64), status: 'observed', config: {} }));
});
