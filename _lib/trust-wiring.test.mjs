// issue #411 (epic #390 Phase 3): trust-wiring.mjs の配線用 canonical テスト。
// issue #471 (epic #390 Phase 6) で buildEvalsealObligation を asserted-only 化し、
// buildEvalsealEvidenceBundle / TRUST_EVALSEAL_MISSING_REASONS を追加。
//
// (a) TRUST_LAYER_CONFIG のキー/値が trust-mode.mjs の TRUST_LAYERS/TRUST_MODES、
//     trust-telemetry.mjs の TELEMETRY_LAYERS/TELEMETRY_MODES と一致すること
//     （trust-telemetry.mjs が Phase 1 で「両定数の一致は Phase 2 の配線 test で担保する」
//     と宣言していた検証を本 test で担保する）。
// (b) buildEvalsealObligation の型 throw（asserted-only。verdict/reasonCode 引数は無い）。
// (b2) buildEvalsealEvidenceBundle の素通し変換（throw しない）。
// (b3) TRUST_EVALSEAL_MISSING_REASONS の closed enum 内容。
// (c) effectiveTrustVerdict の 空/全 invalidated → 'inconclusive'・配列末尾優先。
// (d) formatTrustReceiptsSummary が invalidated 無し入力で trust-telemetry.mjs の
//     formatTrustSummary（import して直接比較）と文字列完全一致、invalidated 付き入力で
//     ` [invalidated]` を含む、空/全 off で ''。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  TRUST_LAYER_CONFIG,
  TRUST_KILL_SWITCH,
  buildEvalsealObligation,
  buildEvalsealEvidenceBundle,
  TRUST_EVALSEAL_MISSING_REASONS,
  effectiveTrustVerdict,
  formatTrustReceiptsSummary,
} from './trust-wiring.mjs';
import { TRUST_LAYERS, TRUST_MODES } from './trust-mode.mjs';
import { TELEMETRY_LAYERS, TELEMETRY_MODES, formatTrustSummary } from './trust-telemetry.mjs';

// ---- (a) 定数一致 ----

test('TRUST_LAYER_CONFIG のキーは trust-mode.mjs の TRUST_LAYERS と一致', () => {
  assert.deepEqual(Object.keys(TRUST_LAYER_CONFIG).sort(), [...TRUST_LAYERS].sort());
});

test('TRUST_LAYER_CONFIG の値は全て trust-mode.mjs の TRUST_MODES に含まれる', () => {
  for (const [layer, mode] of Object.entries(TRUST_LAYER_CONFIG)) {
    assert.ok(TRUST_MODES.includes(mode), `${layer}: "${mode}" は TRUST_MODES に含まれない`);
  }
});

test('TRUST_LAYER_CONFIG のキーは trust-telemetry.mjs の TELEMETRY_LAYERS と一致', () => {
  assert.deepEqual(Object.keys(TRUST_LAYER_CONFIG).sort(), [...TELEMETRY_LAYERS].sort());
});

test('TRUST_LAYER_CONFIG の値は全て trust-telemetry.mjs の TELEMETRY_MODES に含まれる', () => {
  for (const [layer, mode] of Object.entries(TRUST_LAYER_CONFIG)) {
    assert.ok(TELEMETRY_MODES.includes(mode), `${layer}: "${mode}" は TELEMETRY_MODES に含まれない`);
  }
});

test('TRUST_KILL_SWITCH は false（workflow 側 kill switch の既定）', () => {
  assert.equal(TRUST_KILL_SWITCH, false);
});

// ---- (b) buildEvalsealObligation（asserted-only。issue #471） ----

test('buildEvalsealObligation: 正常系（asserted 区画のみを返す。context 未指定は空 object）', () => {
  const o = buildEvalsealObligation({ evidence: ['a', 'b'] });
  assert.deepEqual(o, { asserted: { evidence: ['a', 'b'], context: {} } });
});

test('buildEvalsealObligation: 返り値に verdict/reason_code キーが存在しない（AC-2: derived 区画への外部入力経路が無いことの構造的裏付け）', () => {
  const o = buildEvalsealObligation({ evidence: [] });
  assert.equal('verdict' in o, false);
  assert.equal('reason_code' in o, false);
  assert.deepEqual(Object.keys(o), ['asserted']);
});

test('buildEvalsealObligation: evidence が非配列は throw', () => {
  assert.throws(() => buildEvalsealObligation({ evidence: 'not-array' }));
});

test('buildEvalsealObligation: evidence 未指定は throw', () => {
  assert.throws(() => buildEvalsealObligation({}));
});

test('buildEvalsealObligation: evidence に非文字列要素があると throw', () => {
  assert.throws(() => buildEvalsealObligation({ evidence: ['ok', 123] }));
});

test('buildEvalsealObligation: context に配列を渡すと throw（plain object のみ許可）', () => {
  assert.throws(() => buildEvalsealObligation({ evidence: [], context: ['x'] }));
});

test('buildEvalsealObligation: context に null を渡すと throw', () => {
  assert.throws(() => buildEvalsealObligation({ evidence: [], context: null }));
});

test('buildEvalsealObligation: context に plain object を渡すと asserted.context にそのまま反映される', () => {
  const ctx = { foo: 'bar' };
  const o = buildEvalsealObligation({ evidence: [], context: ctx });
  assert.deepEqual(o.asserted.context, ctx);
});

// ---- (b2) buildEvalsealEvidenceBundle ----

test('buildEvalsealEvidenceBundle: risk/testGreen をそのまま bundle へ包む', () => {
  const risk = { ok: true, hits: [] };
  const b = buildEvalsealEvidenceBundle({ risk, testGreen: true });
  assert.deepEqual(b, { risk, test: { green: true } });
});

test('buildEvalsealEvidenceBundle: risk 未指定は null', () => {
  const b = buildEvalsealEvidenceBundle({ testGreen: false });
  assert.equal(b.risk, null);
  assert.equal(b.test.green, false);
});

test('buildEvalsealEvidenceBundle: testGreen が非 boolean（null/undefined/文字列）は green:null', () => {
  assert.equal(buildEvalsealEvidenceBundle({ testGreen: null }).test.green, null);
  assert.equal(buildEvalsealEvidenceBundle({}).test.green, null);
  assert.equal(buildEvalsealEvidenceBundle({ testGreen: 'true' }).test.green, null);
});

test('buildEvalsealEvidenceBundle: 引数省略でも throw しない', () => {
  assert.doesNotThrow(() => buildEvalsealEvidenceBundle());
});

// ---- (b3) TRUST_EVALSEAL_MISSING_REASONS ----

test('TRUST_EVALSEAL_MISSING_REASONS: closed 6 値 enum', () => {
  assert.deepEqual(TRUST_EVALSEAL_MISSING_REASONS, ['eval_skipped', 'agent_throw', 'agent_null', 'seal_error', 'mode_off', 'unknown']);
});

// ---- (c) effectiveTrustVerdict ----

test('effectiveTrustVerdict: 空配列は inconclusive', () => {
  assert.equal(effectiveTrustVerdict([]), 'inconclusive');
});

test('effectiveTrustVerdict: 全 invalidated は inconclusive', () => {
  const entries = [
    { envelope: { verdict: 'pass' }, invalidated: true, stage: 'evaluate' },
    { envelope: { verdict: 'fail' }, invalidated: true, stage: 'final' },
  ];
  assert.equal(effectiveTrustVerdict(entries), 'inconclusive');
});

test('effectiveTrustVerdict: invalidated でない最新（配列末尾）entry の verdict を返す', () => {
  const entries = [
    { envelope: { verdict: 'pass' }, invalidated: false, stage: 'evaluate' },
    { envelope: { verdict: 'fail' }, invalidated: false, stage: 'final' },
  ];
  assert.equal(effectiveTrustVerdict(entries), 'fail');
});

test('effectiveTrustVerdict: 末尾が invalidated の場合は直前の non-invalidated entry を返す（final 優先の裏付け）', () => {
  const entries = [
    { envelope: { verdict: 'pass' }, invalidated: false, stage: 'evaluate' },
    { envelope: { verdict: 'fail' }, invalidated: true, stage: 'final' },
  ];
  assert.equal(effectiveTrustVerdict(entries), 'pass');
});

test('effectiveTrustVerdict: 非配列入力は inconclusive（fail-safe）', () => {
  assert.equal(effectiveTrustVerdict(null), 'inconclusive');
  assert.equal(effectiveTrustVerdict(undefined), 'inconclusive');
});

// ---- (d) formatTrustReceiptsSummary ----

function sampleEnvelope(overrides = {}) {
  return {
    layer: 'evalseal',
    mode: 'shadow',
    verdict: 'pass',
    reason_code: 'OK',
    subject_kind: 'pr',
    subject_identity: '411',
    receipt_id: 'r-1',
    revision_digest: 'digest-1',
    ...overrides,
  };
}

test('formatTrustReceiptsSummary: invalidated 無し入力は trust-telemetry.mjs の formatTrustSummary と文字列完全一致', () => {
  const envelopes = [sampleEnvelope()];
  assert.equal(formatTrustReceiptsSummary(envelopes), formatTrustSummary(envelopes));
});

test('formatTrustReceiptsSummary: 複数 envelope でも formatTrustSummary と文字列完全一致', () => {
  const envelopes = [
    sampleEnvelope({ layer: 'evalseal', verdict: 'pass' }),
    sampleEnvelope({ layer: 'surfaceproof', verdict: 'fail', mode: 'advisory', receipt_id: 'r-2', revision_digest: 'digest-2' }),
  ];
  assert.equal(formatTrustReceiptsSummary(envelopes), formatTrustSummary(envelopes));
});

test('formatTrustReceiptsSummary: invalidated 付き入力は行末に [invalidated] を含む', () => {
  const envelopes = [sampleEnvelope({ invalidated: true })];
  const out = formatTrustReceiptsSummary(envelopes);
  assert.match(out, /\[invalidated\]/);
});

test('formatTrustReceiptsSummary: invalidated:false は [invalidated] を含まない', () => {
  const envelopes = [sampleEnvelope({ invalidated: false })];
  const out = formatTrustReceiptsSummary(envelopes);
  assert.doesNotMatch(out, /\[invalidated\]/);
});

test('formatTrustReceiptsSummary: 空配列は空文字', () => {
  assert.equal(formatTrustReceiptsSummary([]), '');
});

test('formatTrustReceiptsSummary: 全 mode==="off" は空文字', () => {
  const envelopes = [sampleEnvelope({ mode: 'off' })];
  assert.equal(formatTrustReceiptsSummary(envelopes), '');
});
