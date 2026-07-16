import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  makeLedger, topicKey, canAppend, appendItem,
  checkItem, nextRound, setCheck,
} from './goal-ledger.mjs';
import { gateLane, DEFAULT_GATE_POLICY } from './gate-policy.mjs';

const ac = (over = {}) => ({ id: 'AC-1', text: 'returns 200', dimension: 'ac', severity: 'major', source: 'ac', ...over });

test('topicKey: dimension + 正規化 text', () => {
  assert.equal(topicKey({ dimension: 'security', text: '  No  SQL Injection ' }), 'security::no sql injection');
});

test('canAppend: round 0 は何でも可', () => {
  const l = makeLedger();
  assert.equal(canAppend(l, ac({ severity: 'minor' })), true);
});
test('canAppend: round>=1 は既出 topic か critical のみ', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd', severity: 'major' }));
  ledger = nextRound(ledger);
  assert.equal(canAppend(ledger, ac({ id: 'B', text: 'foo', dimension: 'd', severity: 'minor' })), true);
  assert.equal(canAppend(ledger, ac({ id: 'C', text: 'bar', dimension: 'd', severity: 'minor' })), false);
  assert.equal(canAppend(ledger, ac({ id: 'D', text: 'baz', dimension: 'd', severity: 'critical' })), true);
});

test('appendItem: 受理で accepted:true、新規は default 補完', () => {
  const { ledger, accepted } = appendItem(makeLedger(), ac({ id: 'A' }));
  assert.equal(accepted, true);
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].checked, false);
  assert.equal(ledger.items[0].floor, false);
});
test('appendItem: 単調性違反は accepted:false で ledger 不変', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd' }));
  ledger = nextRound(ledger);
  const res = appendItem(ledger, ac({ id: 'C', text: 'bar', dimension: 'd', severity: 'minor' }));
  assert.equal(res.accepted, false);
  assert.equal(res.ledger.items.length, 1);
});
test('appendItem: 既出 topic は id を保ったまま更新', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd', severity: 'minor' }));
  ledger = nextRound(ledger);
  const { ledger: l2 } = appendItem(ledger, ac({ id: 'IGNORED', text: 'foo', dimension: 'd', severity: 'critical' }));
  assert.equal(l2.items.length, 1);
  assert.equal(l2.items[0].id, 'A');
  assert.equal(l2.items[0].severity, 'critical');
});

test('checkItem: id で checked + evidence', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const l2 = checkItem(ledger, 'A', 'test passed');
  assert.equal(l2.items[0].checked, true);
  assert.equal(l2.items[0].evidence, 'test passed');
});
test('checkItem: 未知 id は throw', () => {
  assert.throws(() => checkItem(makeLedger(), 'X', 'e'), /未知の item id/);
});

test('appendItem: round 0 は同一 topicKey でも別 item として積む（distinct AC を合流させない）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'same', dimension: 'ac', severity: 'major', source: 'ac' });
  ({ ledger } = appendItem(ledger, { id: 'AC-2', text: 'same', dimension: 'ac', severity: 'major', source: 'ac' }));
  assert.equal(ledger.items.length, 2);
  assert.deepEqual(ledger.items.map((i) => i.id), ['AC-1', 'AC-2']);
});
test('setCheck: 既存 item の check 種別を更新（inspection→deterministic で blocking 昇格）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'x', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' } });
  assert.equal(gateLane(ledger.items[0], DEFAULT_GATE_POLICY), 'advisory');
  ledger = setCheck(ledger, 'AC-1', { kind: 'deterministic' });
  assert.equal(ledger.items[0].check.kind, 'deterministic');
  assert.equal(gateLane(ledger.items[0], DEFAULT_GATE_POLICY), 'blocking');
});
test('setCheck: 未知 id は throw', () => {
  assert.throws(() => setCheck(makeLedger(), 'X', { kind: 'deterministic' }), /未知の item id/);
});
test('appendItem: check は shallow-clone され caller mutation の影響を受けない', () => {
  const check = { kind: 'inspection' };
  const { ledger } = appendItem(makeLedger(), { id: 'A', text: 'x', dimension: 'd', severity: 'major', source: 'ac', check });
  check.kind = 'deterministic';                       // caller が後から変更
  assert.equal(ledger.items[0].check.kind, 'inspection'); // ledger 側は不変
});
