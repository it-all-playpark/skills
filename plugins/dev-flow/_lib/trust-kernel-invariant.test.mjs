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
//   (c) dev-flow.js の VM 実行結果 result.merge_tier が、trustGate 未指定の純関数呼び出しと一致する
//       （trustGate:null 明示給電が実際の run で trustGate 未指定と同一に振る舞うことの挙動証拠。
//       ソース文字列 'trustGate: null' の pin は言い回し変更で落ちるため撤去した。issue #636 AC-1）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyMergeTier } from './merge-tier.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

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
// (c) dev-flow.js の実 run（VM 挙動）が、trustGate 未指定の classifyMergeTier 呼び出しと
//     同一の merge_tier を返す（trustGate: null 明示給電＝未指定と同一挙動、が実際に使われている証拠）。
//     標準経路（converged, shape:'standard', docsOrTestOnly:false, danger clean, pr-iterate lgtm）を
//     makeDevFlowSandbox() の既定 responder で再現する。
// ============================================================

test('[trust-kernel-invariant] (c) 標準経路の VM 実行結果 merge_tier が trustGate 未指定の純関数呼び出しと一致する', async () => {
  const { ctx } = makeDevFlowSandbox();
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'trust-kernel-invariant-c');

  assert.ok(result != null, '(c) VM run が result を返さなかった');
  assert.equal(result.merge_tier, 'REVIEW', `(c) 標準経路の merge_tier は 'REVIEW' のはずが '${result.merge_tier}' だった`);

  // dev-flow.js の実 call site（trustGate: null）と同じ状態を、trustGate を一切指定せず純関数へ渡す。
  const expected = classifyMergeTier({
    shape: 'standard',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: false,
    escalateCount: 0,
    iterateStatus: 'lgtm',
  });

  assert.equal(
    result.merge_tier,
    expected.tier,
    `(c) VM run の merge_tier ('${result.merge_tier}') が trustGate 未指定の純関数呼び出し結果 ('${expected.tier}') と一致しない`,
  );
});
