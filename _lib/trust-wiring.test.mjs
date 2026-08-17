// issue #411 (epic #390 Phase 3): trust-wiring.mjs の配線用 canonical テスト。
// issue #471 (epic #390 Phase 6) で TRUST_EVALSEAL_MISSING_REASONS を追加。
// issue #495 で evidence 供給を prompt 埋め込みから実行証跡ファイル参照方式へ移行し、
// buildEvalsealObligation / buildEvalsealEvidenceBundle（旧 obligation/evidence bundle
// builder。dev-flow.js 側の呼び出し元が消えたため canonical からも撤去）のテストを削除した。
//
// (a) TRUST_LAYER_CONFIG のキー/値が trust-mode.mjs の TRUST_LAYERS/TRUST_MODES、
//     trust-telemetry.mjs の TELEMETRY_LAYERS/TELEMETRY_MODES と一致すること
//     （trust-telemetry.mjs が Phase 1 で「両定数の一致は Phase 2 の配線 test で担保する」
//     と宣言していた検証を本 test で担保する）。
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
  TRUST_EVALSEAL_MISSING_REASONS,
  effectiveTrustVerdict,
  formatTrustReceiptsSummary,
  TRUST_EFFECTDELTA_PR_MISSING_REASONS,
  classifyEffectdeltaPrMissing,
  redactEffectdeltaError,
  formatEffectdeltaPrMissingSummary,
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

// ---- (e) TRUST_EFFECTDELTA_PR_MISSING_REASONS（issue #476 D-3: 独立 8 値 closed enum） ----

test('TRUST_EFFECTDELTA_PR_MISSING_REASONS: closed 8 値 enum', () => {
  assert.deepEqual(TRUST_EFFECTDELTA_PR_MISSING_REASONS, [
    'agent_throw',
    'agent_null',
    'mode_off',
    'gh_failed',
    'script_error',
    'agent_error',
    'schema_invalid',
    'unknown',
  ]);
});

// ---- (f) classifyEffectdeltaPrMissing ----

test('classifyEffectdeltaPrMissing: null は agent_null', () => {
  assert.equal(classifyEffectdeltaPrMissing(null), 'agent_null');
});

test('classifyEffectdeltaPrMissing: undefined は agent_null', () => {
  assert.equal(classifyEffectdeltaPrMissing(undefined), 'agent_null');
});

test('classifyEffectdeltaPrMissing: mode:"off" は mode_off', () => {
  assert.equal(classifyEffectdeltaPrMissing({ mode: 'off' }), 'mode_off');
});

test('classifyEffectdeltaPrMissing: ok:false かつ gh 系 error 文字列は gh_failed', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: false, error: 'gh pr view failed: HTTP 403' }), 'gh_failed');
});

test('classifyEffectdeltaPrMissing: ok:false かつ script 系 error 文字列は script_error', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: false, error: 'pr-observe exit 1' }), 'script_error');
});

test('classifyEffectdeltaPrMissing: ok:false かつどちらにもマッチしない error 文字列は agent_error', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: false, error: 'gave up' }), 'agent_error');
});

test('classifyEffectdeltaPrMissing: ok:false かつ error 無しは agent_error', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: false }), 'agent_error');
});

test('classifyEffectdeltaPrMissing: ok:false かつ error が非文字列は agent_error', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: false, error: { code: 500 } }), 'agent_error');
});

test('classifyEffectdeltaPrMissing: ok:true（成功条件未達で到達）は schema_invalid', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: true }), 'schema_invalid');
});

test('classifyEffectdeltaPrMissing: gh 系と script 系の両方の token を含む error は gh_failed が優先', () => {
  assert.equal(classifyEffectdeltaPrMissing({ ok: false, error: 'gh failed: pr-observe skipped' }), 'gh_failed');
});

test('classifyEffectdeltaPrMissing: それ以外の未知形状は unknown', () => {
  assert.equal(classifyEffectdeltaPrMissing({}), 'unknown');
});

// ---- (g) redactEffectdeltaError ----

test('redactEffectdeltaError: 非文字列は空文字', () => {
  assert.equal(redactEffectdeltaError(null), '');
  assert.equal(redactEffectdeltaError(undefined), '');
  assert.equal(redactEffectdeltaError(123), '');
  assert.equal(redactEffectdeltaError({ code: 500 }), '');
});

test('redactEffectdeltaError: URL は <url> に置換される', () => {
  assert.equal(redactEffectdeltaError('failed: see https://api.github.com/repos/x/y for details'), 'failed: see <url> for details');
});

test('redactEffectdeltaError: 16 文字以上の token 様文字列は <token> に置換される', () => {
  const out = redactEffectdeltaError('auth failed token=ghp_abcdefghijklmnopqrstuvwxyz');
  assert.match(out, /<token>/);
  assert.doesNotMatch(out, /ghp_abcdefghijklmnopqrstuvwxyz/);
});

test('redactEffectdeltaError: 複数行は先頭行のみを対象にする', () => {
  assert.equal(redactEffectdeltaError('first line\nsecond line with secret'), 'first line');
});

test('redactEffectdeltaError: 120 文字に truncate される', () => {
  const longError = 'error occurred while processing the request '.repeat(5);
  const out = redactEffectdeltaError(longError);
  assert.equal(out.length, 120);
});

// ---- (h) formatEffectdeltaPrMissingSummary ----

test('formatEffectdeltaPrMissingSummary: null は空文字', () => {
  assert.equal(formatEffectdeltaPrMissingSummary(null), '');
});

test('formatEffectdeltaPrMissingSummary: 空文字は空文字', () => {
  assert.equal(formatEffectdeltaPrMissingSummary(''), '');
});

test('formatEffectdeltaPrMissingSummary: 非文字列は空文字', () => {
  assert.equal(formatEffectdeltaPrMissingSummary(undefined), '');
  assert.equal(formatEffectdeltaPrMissingSummary(123), '');
});

test('formatEffectdeltaPrMissingSummary: reason 入力でブロック文字列を完全一致で返す', () => {
  const out = formatEffectdeltaPrMissingSummary('agent_error');
  assert.equal(
    out,
    '### Trust receipts (shadow) — missing\n\n- effectdelta [shadow]: INCONCLUSIVE (missing_reason=agent_error) stage=pr',
  );
});
