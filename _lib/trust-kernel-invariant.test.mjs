// trust-layer 残す集合（kernel）の静的 invariant（issue #507）。
//
// call site 撤去後も残す境界を機械検証する。「_lib/trust-layers-off.test.mjs が削除境界の外側
// （撤去対象）」を pin するのに対し、本ファイルは「削除境界の内側（残置 kernel）」を pin する — 対で
// 中途半端な過剰削除（kernel まで消してしまう）を検知する。
//
// テストケース:
//   (a) 残置 kernel 4 モジュール + 各テスト、fixtures、dev-flow-doctor の trust receipts レポート/
//       fixture が存在する
//   (b) classifyMergeTier の trustGate 経路が生きており、未指定時の出力が trustGate:null と完全一致する
//   (c) dev-flow.js が classifyMergeTier( を呼び、trustGate: null を明示給電し続けている

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyMergeTier } from './merge-tier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// (a) 残置 kernel 成果物の存在
// ============================================================

const KERNEL_MODULES = [
  '_lib/trust-schema.mjs',
  '_lib/trust-schema.test.mjs',
  '_lib/trust-digest.mjs',
  '_lib/trust-digest.test.mjs',
  '_lib/trust-mode.mjs',
  '_lib/trust-mode.test.mjs',
  '_lib/trust-telemetry.mjs',
  '_lib/trust-telemetry.test.mjs',
  '_lib/trust-consistency.test.mjs',
  '_lib/trust-fixtures.test.mjs',
];

const FIXTURE_FILES = [
  '_lib/fixtures/trust/valid-surfaceproof.json',
  '_lib/fixtures/trust/valid-evalseal.json',
  '_lib/fixtures/trust/valid-effectdelta.json',
  '_lib/fixtures/trust/adversarial-capability-missing.json',
  '_lib/fixtures/trust/adversarial-cross-protocol.json',
  '_lib/fixtures/trust/adversarial-digest-mismatch.json',
  '_lib/fixtures/trust/adversarial-schema-invalid.json',
  '_lib/fixtures/trust/adversarial-unknown-enum.json',
  '_lib/fixtures/trust/adversarial-unknown-field.json',
];

const DOCTOR_PATHS = [
  'dev-flow-doctor/scripts/trust-receipts-report.sh',
  'dev-flow-doctor/scripts/trust-receipts-report.bats',
  'dev-flow-doctor/scripts/trust-receipts-matrix.bats',
  'dev-flow-doctor/scripts/trust-receipts-planted.bats',
  'dev-flow-doctor/scripts/trust-baseline-snapshot.sh',
  'dev-flow-doctor/scripts/trust-baseline-snapshot.bats',
  'dev-flow-doctor/tests/fixtures/trust-receipts',
  'dev-flow-doctor/tests/fixtures/trust-baseline',
];

for (const relPath of [...KERNEL_MODULES, ...FIXTURE_FILES, ...DOCTOR_PATHS]) {
  test(`[trust-kernel-invariant] (a) ${relPath} が存在する`, () => {
    assert.equal(
      existsSync(join(repoRoot, relPath)), true,
      `(a) 残置対象の kernel 成果物 ${relPath} が存在しない`,
    );
  });
}

// ============================================================
// (b) classifyMergeTier の trustGate 経路存続と未指定時同一性
// ============================================================

function autoBase() {
  return {
    shape: 'micro',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: true,
    escalateCount: 0,
  };
}

test('[trust-kernel-invariant] (b) trustGate 未指定と trustGate:null は同一結果', () => {
  const base = autoBase();
  const withoutTrustGate = classifyMergeTier(base);
  const withNullTrustGate = classifyMergeTier({ ...base, trustGate: null });
  assert.deepEqual(withoutTrustGate, withNullTrustGate);
});

test('[trust-kernel-invariant] (b) trustGate blocking かつ非pass は HOLD + 専用 reason', () => {
  const base = autoBase();
  const result = classifyMergeTier({ ...base, trustGate: { blocking: true, verdict: 'fail' } });
  assert.equal(result.tier, 'HOLD');
  assert.ok(
    result.reasons.some((r) => r.includes('EvalSeal receipt 非 pass')),
    'trustGate blocking かつ verdict!==pass のとき専用 HOLD reason が出ること',
  );
});

test('[trust-kernel-invariant] (b) trustGate の verdict が enum 外なら throw', () => {
  const base = autoBase();
  assert.throws(() => {
    classifyMergeTier({ ...base, trustGate: { blocking: true, verdict: 'bogus' } });
  });
});

// ============================================================
// (c) dev-flow.js が classifyMergeTier( を呼び trustGate: null を給電する
// ============================================================

test('[trust-kernel-invariant] (c) dev-flow.js に classifyMergeTier( 呼び出しがある', () => {
  assert.ok(
    devFlowSrc.includes('classifyMergeTier('),
    '(c) dev-flow.js から classifyMergeTier( の呼び出しが見つからない',
  );
});

test('[trust-kernel-invariant] (c) dev-flow.js に trustGate: null の明示給電がある', () => {
  assert.ok(
    devFlowSrc.includes('trustGate: null'),
    '(c) dev-flow.js が classifyMergeTier へ trustGate: null を明示給電していない（S3完了後に green）',
  );
});
