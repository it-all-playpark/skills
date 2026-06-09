import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_POLICIES,
  DEFAULT_GATE_POLICY,
  resolveGatePolicy,
  gateLane,
  policyBlockingItems,
  policyAdvisoryItems,
  isConvergedUnderPolicy,
} from './gate-policy.mjs';
import { laneOf } from './goal-ledger.mjs';

// ---- (1) resolveGatePolicy ----

test('GATE_POLICIES は trust 昇順の 4 値配列', () => {
  assert.deepEqual(GATE_POLICIES, [
    'deterministic-only',
    'llm-major-advisory',
    'llm-major-blocking',
    'llm-autonomous',
  ]);
});

test('DEFAULT_GATE_POLICY は llm-major-advisory', () => {
  assert.equal(DEFAULT_GATE_POLICY, 'llm-major-advisory');
});

test('resolveGatePolicy: null → DEFAULT_GATE_POLICY', () => {
  assert.equal(resolveGatePolicy(null), DEFAULT_GATE_POLICY);
});

test('resolveGatePolicy: undefined → DEFAULT_GATE_POLICY', () => {
  assert.equal(resolveGatePolicy(undefined), DEFAULT_GATE_POLICY);
});

test('resolveGatePolicy: 空文字 → DEFAULT_GATE_POLICY', () => {
  assert.equal(resolveGatePolicy(''), DEFAULT_GATE_POLICY);
});

test('resolveGatePolicy: 有効な policy 値をそのまま返す', () => {
  for (const p of GATE_POLICIES) {
    assert.equal(resolveGatePolicy(p), p);
  }
});

test('resolveGatePolicy: 未知の値は throw', () => {
  assert.throws(
    () => resolveGatePolicy('unknown-policy'),
    /gate-policy: 未知の gate_policy "unknown-policy"/,
  );
  assert.throws(
    () => resolveGatePolicy('bogus'),
    /gate-policy: 未知の gate_policy "bogus".*許可/,
  );
});

// ---- (2) 軸A invariant: deterministic / seed / critical は全 policy で blocking ----

const mkItem = (over = {}) => ({
  id: 'TEST-1', text: 'test item', dimension: 'test',
  severity: 'major', source: 'ac', checked: false,
  evidence: null, floor: false, check: null,
  ...over,
});

test('gateLane: critical item は全 policy で blocking', () => {
  const item = mkItem({ severity: 'critical' });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'blocking', `policy=${p}`);
  }
});

test('gateLane: deterministic check 付き item は全 policy で blocking', () => {
  const item = mkItem({ severity: 'major', check: { kind: 'deterministic' } });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'blocking', `policy=${p}`);
  }
});

test('gateLane: source=seed item は全 policy で blocking', () => {
  const item = mkItem({ severity: 'major', source: 'seed' });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'blocking', `policy=${p}`);
  }
});

// ---- (3) default-equivalence: llm-major-advisory では goal-ledger.mjs の laneOf と一致 ----

test('gateLane default-equivalence: llm-major-advisory は laneOf と完全一致', () => {
  const items = [
    mkItem({ id: 'critical', severity: 'critical' }),
    mkItem({ id: 'deterministic', check: { kind: 'deterministic' }, severity: 'major' }),
    mkItem({ id: 'seed', source: 'seed', severity: 'major' }),
    mkItem({ id: 'llm-major', severity: 'major', source: 'evaluator' }),
    mkItem({ id: 'llm-minor', severity: 'minor', source: 'ac' }),
    mkItem({ id: 'inspection', check: { kind: 'inspection' }, severity: 'major', source: 'ac' }),
  ];
  for (const it of items) {
    assert.equal(
      gateLane(it, 'llm-major-advisory'),
      laneOf(it),
      `item id=${it.id}: gateLane vs laneOf 不一致`,
    );
  }
});

// ---- (4) llm-major-blocking では LLM major が blocking に転じる ----

test('gateLane: llm-major-blocking で LLM major は blocking', () => {
  const item = mkItem({ severity: 'major', source: 'evaluator', check: null });
  assert.equal(gateLane(item, 'llm-major-blocking'), 'blocking');
});

test('gateLane: llm-major-advisory で LLM major は advisory', () => {
  const item = mkItem({ severity: 'major', source: 'evaluator', check: null });
  assert.equal(gateLane(item, 'llm-major-advisory'), 'advisory');
});

test('gateLane: deterministic-only で LLM major は advisory', () => {
  const item = mkItem({ severity: 'major', source: 'evaluator', check: null });
  assert.equal(gateLane(item, 'deterministic-only'), 'advisory');
});

test('gateLane: llm-autonomous で LLM major は advisory', () => {
  const item = mkItem({ severity: 'major', source: 'evaluator', check: null });
  assert.equal(gateLane(item, 'llm-autonomous'), 'advisory');
});

// ---- LLM minor は全 policy で advisory ----

test('gateLane: LLM minor は全 policy で advisory', () => {
  const item = mkItem({ severity: 'minor', source: 'ac', check: null });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'advisory', `policy=${p}`);
  }
});

// ---- (5) isConvergedUnderPolicy ----

test('isConvergedUnderPolicy: blocking 全 checked で true', () => {
  const items = [
    { ...mkItem({ id: 'A', severity: 'critical' }), checked: true },
    { ...mkItem({ id: 'B', severity: 'minor' }), checked: false },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
});

test('isConvergedUnderPolicy: blocking 未 checked で false', () => {
  const items = [
    { ...mkItem({ id: 'A', severity: 'critical' }), checked: false },
    { ...mkItem({ id: 'B', severity: 'minor' }), checked: true },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), false);
});

test('isConvergedUnderPolicy: llm-major-blocking で LLM major が blocking に入り未 checked → false', () => {
  const items = [
    { ...mkItem({ id: 'A', severity: 'major', source: 'evaluator', check: null }), checked: false },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-blocking'), false);
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
});

test('isConvergedUnderPolicy: 空 ledger は true', () => {
  assert.equal(isConvergedUnderPolicy({ items: [], round: 0 }, 'llm-major-advisory'), true);
});

// ---- policyBlockingItems / policyAdvisoryItems ----

test('policyBlockingItems / policyAdvisoryItems: 分離が正しい', () => {
  const items = [
    { ...mkItem({ id: 'crit', severity: 'critical' }), checked: false },
    { ...mkItem({ id: 'llm-maj', severity: 'major', source: 'evaluator', check: null }), checked: false },
    { ...mkItem({ id: 'llm-min', severity: 'minor', source: 'ac', check: null }), checked: false },
  ];
  const ledger = { items, round: 0 };

  // llm-major-advisory: critical=blocking, llm-maj=advisory, llm-min=advisory
  const blocking = policyBlockingItems(ledger, 'llm-major-advisory');
  const advisory = policyAdvisoryItems(ledger, 'llm-major-advisory');
  assert.deepEqual(blocking.map((i) => i.id), ['crit']);
  assert.deepEqual(advisory.map((i) => i.id), ['llm-maj', 'llm-min']);

  // llm-major-blocking: critical=blocking, llm-maj=blocking, llm-min=advisory
  const blocking2 = policyBlockingItems(ledger, 'llm-major-blocking');
  const advisory2 = policyAdvisoryItems(ledger, 'llm-major-blocking');
  assert.deepEqual(blocking2.map((i) => i.id), ['crit', 'llm-maj']);
  assert.deepEqual(advisory2.map((i) => i.id), ['llm-min']);
});
