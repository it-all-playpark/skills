import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DANGER_CLASSES,
  seedSecurityLedger,
  reconcileDanger,
  isDocsOrTestOnly,
  classifyMergeTier,
} from './merge-tier.mjs';

// ---- Task 1: DANGER_CLASSES + seedSecurityLedger ----

test('DANGER_CLASSES は diff-risk-classify.sh の 7 クラスと一致', () => {
  assert.deepEqual(DANGER_CLASSES, [
    'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
  ]);
});

test('seedSecurityLedger は 7 クラスを blocking seed item として返す', () => {
  const seeds = seedSecurityLedger();
  assert.equal(seeds.length, 7);
  for (const s of seeds) {
    assert.equal(s.source, 'seed');
    assert.equal(s.dimension, 'security');
    assert.equal(s.severity, 'major');           // source:'seed' で blocking。hit 時に critical へ raise
    assert.deepEqual(s.check, { kind: 'deterministic' });
    assert.ok(s.id.startsWith('SEC-'));
    assert.ok(s.text.length > 0);
  }
  assert.equal(seeds[0].id, 'SEC-AUTH');
  assert.equal(seeds[3].id, 'SEC-DATA-MIGRATION');
});

// ---- Task 2: reconcileDanger ----

function ledgerWithSeeds() {
  return {
    items: seedSecurityLedger().map((it) => ({ checked: false, evidence: null, floor: false, ...it })),
    round: 0,
  };
}

test('reconcileDanger: clean クラスは checked=true(evidence=grep clean)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), []);
  for (const it of out.items) {
    assert.equal(it.checked, true);
    assert.match(it.evidence, /clean/);
    assert.equal(it.severity, 'major');
  }
});

test('reconcileDanger: hit クラスは critical へ raise + checked=false 据え置き', () => {
  const out = reconcileDanger(ledgerWithSeeds(), ['auth', 'crypto']);
  const auth = out.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.severity, 'critical');
  assert.equal(auth.floor, true);
  assert.equal(auth.checked, false);
  const cfg = out.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfg.severity, 'major');
  assert.equal(cfg.checked, true);
});

test('reconcileDanger: 未知 hit クラスは無視(対応 seed なし)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), ['bogus']);
  assert.ok(out.items.every((it) => it.checked === true));
});

// ---- Task 3: isDocsOrTestOnly + classifyMergeTier ----

test('isDocsOrTestOnly: md/test/bats のみ → true', () => {
  assert.equal(isDocsOrTestOnly(['docs/a.md', 'README.md']), true);
  assert.equal(isDocsOrTestOnly(['_lib/foo.test.mjs', 'x/foo.bats']), true);
  assert.equal(isDocsOrTestOnly(['src/foo.ts']), false);
  assert.equal(isDocsOrTestOnly([]), false);
});

test('classifyMergeTier: 未収束 → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: false, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /収束/.test(x)));
});

test('classifyMergeTier: 未解消 danger → HOLD', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: true, breaking: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: breaking → HOLD', () => {
  const r = classifyMergeTier({ shape: 'complex', converged: true, unresolvedDanger: false, breaking: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: ESCALATE 項目あり → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 2 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: micro + docs/test-only + clean + 収束 → AUTO', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
});

test('classifyMergeTier: 収束済だが micro でない/コード変更 → REVIEW', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: micro だが docs/test-only でない → REVIEW', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});
