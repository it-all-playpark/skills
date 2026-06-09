import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeLedger, laneOf, topicKey, canAppend, appendItem,
  applySeverityFloor, mergeSeverity, checkItem, reopenItem,
  blockingItems, advisoryItems, isConverged, nextRound, setCheck,
} from './goal-ledger.mjs';

const ac = (over = {}) => ({ id: 'AC-1', text: 'returns 200', dimension: 'ac', severity: 'major', source: 'ac', ...over });

test('laneOf: critical は blocking', () => {
  assert.equal(laneOf(ac({ severity: 'critical' })), 'blocking');
});
test('laneOf: deterministic check 付きは blocking', () => {
  assert.equal(laneOf(ac({ severity: 'minor', check: { kind: 'deterministic' } })), 'blocking');
});
test('laneOf: seed source は blocking', () => {
  assert.equal(laneOf(ac({ severity: 'minor', source: 'seed' })), 'blocking');
});
test('laneOf: それ以外(LLM major/minor, inspection)は advisory', () => {
  assert.equal(laneOf(ac({ severity: 'major', check: { kind: 'inspection' } })), 'advisory');
  assert.equal(laneOf(ac({ severity: 'minor' })), 'advisory');
});

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

test('applySeverityFloor: severity を floor 以上へ引き上げ floor=true', () => {
  const r = applySeverityFloor(ac({ severity: 'minor' }), 'critical');
  assert.equal(r.severity, 'critical');
  assert.equal(r.floor, true);
});
test('mergeSeverity: LLM は raise 可', () => {
  assert.equal(mergeSeverity(ac({ severity: 'minor', floor: false }), 'critical').severity, 'critical');
});
test('mergeSeverity: floor 項目を LLM が lower できない', () => {
  const floored = applySeverityFloor(ac({ severity: 'critical' }), 'critical');
  assert.equal(mergeSeverity(floored, 'minor').severity, 'critical');
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
test('reopenItem: id + reason 必須、未知 id / reason 無しは throw', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const checked = checkItem(ledger, 'A', 'e');
  const reopened = reopenItem(checked, 'A', 'regression detected');
  assert.equal(reopened.items[0].checked, false);
  assert.equal(reopened.items[0].reopen_reason, 'regression detected');
  assert.throws(() => reopenItem(checked, 'X', 'r'), /未知の item id/);
  assert.throws(() => reopenItem(checked, 'A', ''), /reason が必要/);
});

test('isConverged: blocking 全 checked で true、advisory 未 checked は無関係', () => {
  let l = makeLedger();
  l = appendItem(l, ac({ id: 'B', severity: 'critical' })).ledger;
  l = appendItem(l, ac({ id: 'A', severity: 'minor' })).ledger;
  assert.equal(isConverged(l), false);
  l = checkItem(l, 'B', 'done');
  assert.equal(isConverged(l), true);
});
test('blockingItems / advisoryItems の分離', () => {
  let l = makeLedger();
  l = appendItem(l, ac({ id: 'B', severity: 'critical' })).ledger;
  l = appendItem(l, ac({ id: 'A', severity: 'minor' })).ledger;
  assert.equal(blockingItems(l).map((i) => i.id).join(','), 'B');
  assert.equal(advisoryItems(l).map((i) => i.id).join(','), 'A');
});

test('isConverged: 空 ledger(blocking 0件)は true（every([])===true を pin）', () => {
  assert.equal(isConverged(makeLedger()), true);
});
test('appendItem: round 0 は同一 topicKey でも別 item として積む（distinct AC を合流させない）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'same', dimension: 'ac', severity: 'major', source: 'ac' });
  ({ ledger } = appendItem(ledger, { id: 'AC-2', text: 'same', dimension: 'ac', severity: 'major', source: 'ac' }));
  assert.equal(ledger.items.length, 2);
  assert.deepEqual(ledger.items.map((i) => i.id), ['AC-1', 'AC-2']);
});
test('mergeSeverity: 未定義 severity は現状 fail-safe passthrough（NaN比較で現値維持）', () => {
  assert.equal(mergeSeverity({ severity: 'major', floor: false }, 'bogus').severity, 'major');
  const floored = applySeverityFloor({ severity: 'critical' }, 'critical');
  assert.equal(mergeSeverity(floored, 'bogus').severity, 'critical');
});
test('setCheck: 既存 item の check 種別を更新（inspection→deterministic で blocking 昇格）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'x', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' } });
  assert.equal(laneOf(ledger.items[0]), 'advisory');
  ledger = setCheck(ledger, 'AC-1', { kind: 'deterministic' });
  assert.equal(ledger.items[0].check.kind, 'deterministic');
  assert.equal(laneOf(ledger.items[0]), 'blocking');
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
