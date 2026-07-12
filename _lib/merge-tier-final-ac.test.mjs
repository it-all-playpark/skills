// classifyMergeTier: finalAcReconcile（Final AC reconcile phase, issue #331/F2）
//
// s.finalAcReconcile (optional 'skipped'|'reverified'|'unavailable') の enum 検証と
// 'unavailable' 時の HOLD reason 追加を検証する。'reverified'/'skipped'/未指定は
// 既存挙動（tier・reasons）を変えない（regression なし）。
//
// このテストファイルは TDD red として作成された。F2 実装（classifyMergeTier への
// s.finalAcReconcile 追加）完了後に green になる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMergeTier } from './merge-tier.mjs';

// AUTO 適格 base（micro + docs/test-only + danger clean + 収束）
function autoBase() {
  return {
    shape: 'micro',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: true,
    escalateCount: 0,
    iterateStatus: 'lgtm',
    evalStaleness: 'none',
  };
}

// REVIEW 相当 base（standard、他条件クリーン）
function standardBase() {
  return {
    shape: 'standard',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: false,
    escalateCount: 0,
    iterateStatus: 'lgtm',
    evalStaleness: 'none',
  };
}

test('classifyMergeTier: finalAcReconcile:"unavailable"（REVIEW 相当条件）→ tier===HOLD かつ reasons に "Final AC reconcile 判定不能" を含む', () => {
  const r = classifyMergeTier({ ...standardBase(), finalAcReconcile: 'unavailable' });
  assert.equal(r.tier, 'HOLD');
  assert.ok(
    r.reasons.some((x) => x.includes('Final AC reconcile 判定不能')),
    `reasons に 'Final AC reconcile 判定不能' を含むべきだが: ${JSON.stringify(r.reasons)}`,
  );
});

test('classifyMergeTier: finalAcReconcile:"unavailable"（AUTO 相当条件: micro+docs/test-only）でも HOLD（決定論 HOLD が AUTO に勝つ）', () => {
  const r = classifyMergeTier({ ...autoBase(), finalAcReconcile: 'unavailable' });
  assert.equal(r.tier, 'HOLD');
  assert.ok(
    r.reasons.some((x) => x.includes('Final AC reconcile 判定不能')),
    `reasons に 'Final AC reconcile 判定不能' を含むべきだが: ${JSON.stringify(r.reasons)}`,
  );
});

test('classifyMergeTier: finalAcReconcile:"reverified" → tier・reasons が従来と同一（"Final AC reconcile" 文言なし）', () => {
  const base = standardBase();
  const withoutFlag = classifyMergeTier(base);
  const withFlag = classifyMergeTier({ ...base, finalAcReconcile: 'reverified' });
  assert.equal(withFlag.tier, withoutFlag.tier);
  assert.deepEqual(withFlag.reasons, withoutFlag.reasons);
  assert.ok(!withFlag.reasons.some((x) => /Final AC reconcile/.test(x)));
});

test('classifyMergeTier: finalAcReconcile:"skipped" → tier・reasons が従来と同一（"Final AC reconcile" 文言なし）', () => {
  const base = standardBase();
  const withoutFlag = classifyMergeTier(base);
  const withFlag = classifyMergeTier({ ...base, finalAcReconcile: 'skipped' });
  assert.equal(withFlag.tier, withoutFlag.tier);
  assert.deepEqual(withFlag.reasons, withoutFlag.reasons);
  assert.ok(!withFlag.reasons.some((x) => /Final AC reconcile/.test(x)));
});

test('classifyMergeTier: finalAcReconcile 未指定 → tier・reasons が従来と同一（"Final AC reconcile" 文言なし、regression なし）', () => {
  const base = standardBase();
  const r = classifyMergeTier(base);
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /Final AC reconcile/.test(x)));
});

test('classifyMergeTier: finalAcReconcile:"stale"(out-of-enum) → throw with "invalid finalAcReconcile"', () => {
  assert.throws(
    () => classifyMergeTier({ ...standardBase(), finalAcReconcile: 'stale' }),
    /invalid finalAcReconcile/,
  );
});
