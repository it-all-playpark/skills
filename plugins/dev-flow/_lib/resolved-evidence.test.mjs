import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildResolvedEvidence, RESOLVED_EVIDENCE_FIELD_CAP, RESOLVED_EVIDENCE_MAX_CHARS } from './resolved-evidence.mjs';

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.getOwnPropertyNames(obj).forEach((k) => deepFreeze(obj[k]));
    Object.freeze(obj);
  }
  return obj;
}

// 1. 全入力 undefined/null/空配列 -> null
test('buildResolvedEvidence: 全入力 undefined -> null', () => {
  assert.equal(buildResolvedEvidence({}), null);
});

test('buildResolvedEvidence: 全入力 null -> null', () => {
  assert.equal(
    buildResolvedEvidence({ blockingItems: null, advisoryItems: null, acResults: null }),
    null
  );
});

test('buildResolvedEvidence: 全入力 空配列 -> null', () => {
  assert.equal(
    buildResolvedEvidence({ blockingItems: [], advisoryItems: [], acResults: [] }),
    null
  );
});

// 2. 選別パリティ
test('buildResolvedEvidence: blocking checked は lane blocking で ledger_resolved に含まれる', () => {
  const blockingItems = [
    { id: 'B1', text: 'blocking done', evidence: 'ev-b1', checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.equal(out.ledger_resolved.length, 1);
  assert.equal(out.ledger_resolved[0].lane, 'blocking');
  assert.equal(out.ledger_resolved[0].id, 'B1');
  assert.equal(out.ledger_resolved[0].dimension, 'quality');
  assert.equal(out.ledger_resolved[0].text, 'blocking done');
  assert.equal(out.ledger_resolved[0].evidence, 'ev-b1');
});

test('buildResolvedEvidence: advisory checked（escalate無・非env）は lane advisory で ledger_resolved に含まれる', () => {
  const advisoryItems = [
    { id: 'A1', text: 'advisory done', evidence: 'ev-a1', checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems: [], advisoryItems, acResults: [] });
  assert.equal(out.ledger_resolved.length, 1);
  assert.equal(out.ledger_resolved[0].lane, 'advisory');
  assert.equal(out.ledger_resolved[0].id, 'A1');
});

test('buildResolvedEvidence: advisory checked かつ escalate:true は ledger_resolved に含まれない', () => {
  const advisoryItems = [
    { id: 'A2', text: 'escalated', evidence: 'ev-a2', checked: true, escalate: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems: [], advisoryItems, acResults: [] });
  // escalate item は ledger_resolved から除外されるので、他条件が全て空なら null
  assert.equal(out, null);
});

test('buildResolvedEvidence: dimension:environment の advisory は checked に関わらず env_notes のみ（ledger_resolved に出ない）', () => {
  const advisoryItems = [
    { id: 'E1', text: 'env checked', evidence: 'ev-e1', checked: true, dimension: 'environment', env_key: 'turbopack-sandbox', env_count: 3 },
    { id: 'E2', text: 'env unchecked', evidence: 'ev-e2', checked: false, dimension: 'environment' },
  ];
  const out = buildResolvedEvidence({ blockingItems: [], advisoryItems, acResults: [] });
  assert.equal(out.ledger_resolved.length, 0);
  assert.equal(out.env_notes.length, 2);
  const e1 = out.env_notes.find((e) => e.id === 'E1');
  assert.equal(e1.env_key, 'turbopack-sandbox');
  assert.equal(e1.env_count, 3);
  assert.equal(e1.checked, true);
  assert.equal(e1.text, 'env checked');
  assert.equal(e1.evidence, 'ev-e1');
  const e2 = out.env_notes.find((e) => e.id === 'E2');
  assert.equal(e2.checked, false);
  assert.equal(e2.env_key, null);
  assert.equal(e2.env_count, 1);
});

test('buildResolvedEvidence: unchecked blocking は ledger_resolved に出ない', () => {
  const blockingItems = [
    { id: 'B2', text: 'not done', evidence: 'ev-b2', checked: false, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.equal(out, null);
});

test('buildResolvedEvidence: SEC seed checked は ledger_resolved と security_cleared の両方、unchecked はどちらにも出ない', () => {
  const blockingItemsChecked = [
    { id: 'SEC-1', text: 'sec done', evidence: 'ev-sec1', checked: true, source: 'seed', dimension: 'security', floor: true, danger_class: 'eval' },
  ];
  const outChecked = buildResolvedEvidence({ blockingItems: blockingItemsChecked, advisoryItems: [], acResults: [] });
  assert.equal(outChecked.ledger_resolved.length, 1);
  assert.equal(outChecked.ledger_resolved[0].lane, 'blocking');
  assert.equal(outChecked.security_cleared.length, 1);
  assert.equal(outChecked.security_cleared[0].danger_class, 'eval');
  assert.equal(outChecked.security_cleared[0].evidence, 'ev-sec1');

  const blockingItemsUnchecked = [
    { id: 'SEC-2', text: 'sec not done', evidence: 'ev-sec2', checked: false, source: 'seed', dimension: 'security', floor: true, danger_class: 'eval' },
  ];
  const outUnchecked = buildResolvedEvidence({ blockingItems: blockingItemsUnchecked, advisoryItems: [], acResults: [] });
  assert.equal(outUnchecked, null);
});

test('buildResolvedEvidence: acResults satisfied:false は ac_satisfied に出ない', () => {
  const acResults = [
    { ac_index: 0, satisfied: false, evidence: 'ev-ac0' },
  ];
  const out = buildResolvedEvidence({ blockingItems: [], advisoryItems: [], acResults });
  assert.equal(out, null);
});

test('buildResolvedEvidence: verified_by 欠落は inspection', () => {
  const acResults = [
    { ac_index: 1, satisfied: true, evidence: 'ev-ac1' },
  ];
  const out = buildResolvedEvidence({ blockingItems: [], advisoryItems: [], acResults });
  assert.equal(out.ac_satisfied.length, 1);
  assert.equal(out.ac_satisfied[0].ac_index, 1);
  assert.equal(out.ac_satisfied[0].verified_by, 'inspection');
  assert.equal(out.ac_satisfied[0].evidence, 'ev-ac1');
});

test('buildResolvedEvidence: acResults satisfied:true かつ verified_by 明示は保持される', () => {
  const acResults = [
    { ac_index: 2, satisfied: true, evidence: 'ev-ac2', verified_by: 'test' },
  ];
  const out = buildResolvedEvidence({ blockingItems: [], advisoryItems: [], acResults });
  assert.equal(out.ac_satisfied[0].verified_by, 'test');
});

// 3. per-field cap
test('buildResolvedEvidence: evidence 1500字 -> 1000字に切り詰め, truncated:true, cap_chars:1000', () => {
  const longEvidence = 'x'.repeat(1500);
  const blockingItems = [
    { id: 'B3', text: 'short text', evidence: longEvidence, checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.equal(out.cap_chars, RESOLVED_EVIDENCE_FIELD_CAP);
  assert.equal(out.truncated, true);
  assert.equal(out.ledger_resolved[0].evidence.length, 1000);
  assert.equal(out.ledger_resolved[0].evidence, 'x'.repeat(1000));
});

test('buildResolvedEvidence: 1000字ちょうどは切り詰めない (truncated:false)', () => {
  const evidence1000 = 'y'.repeat(1000);
  const blockingItems = [
    { id: 'B4', text: 'ok', evidence: evidence1000, checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.equal(out.truncated, false);
  assert.equal(out.cap_chars, RESOLVED_EVIDENCE_FIELD_CAP);
  assert.equal(out.ledger_resolved[0].evidence, evidence1000);
});

// 4. 総量 cap
test('buildResolvedEvidence: 21件 x (text100字+evidence1000字) -> JSON長 <= 16000, cap_chars<1000, truncated:true, 件数は落とさない', () => {
  const blockingItems = [];
  for (let i = 0; i < 21; i++) {
    blockingItems.push({
      id: `B${i}`,
      text: 't'.repeat(100),
      evidence: 'e'.repeat(1000),
      checked: true,
      dimension: 'quality',
    });
  }
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.ok(JSON.stringify(out).length <= RESOLVED_EVIDENCE_MAX_CHARS);
  assert.ok(out.cap_chars < RESOLVED_EVIDENCE_FIELD_CAP);
  assert.equal(out.truncated, true);
  assert.equal(out.ledger_resolved.length, 21);
});

// 5. n -> 0 到達
test('buildResolvedEvidence: 60件 x evidence1000字+text1000字 -> JSON長<=16000, cap_chars===0 または上限内', () => {
  const blockingItems = [];
  for (let i = 0; i < 60; i++) {
    blockingItems.push({
      id: `B${i}`,
      text: 't'.repeat(1000),
      evidence: 'e'.repeat(1000),
      checked: true,
      dimension: 'quality',
    });
  }
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.ok(JSON.stringify(out).length <= RESOLVED_EVIDENCE_MAX_CHARS);
  assert.equal(out.ledger_resolved.length, 60);
  if (out.cap_chars === 0) {
    for (const item of out.ledger_resolved) {
      assert.equal(item.text, '');
      assert.equal(item.evidence, '');
    }
  }
});

// 6. 特殊文字
test('buildResolvedEvidence: 特殊文字（|, バッククォート, 改行, 二重引用符, バックスラッシュ）が JSON 往復可能でエスケープされない', () => {
  const special = 'a|b`c\nd"e\\f';
  const blockingItems = [
    { id: 'B5', text: 'special', evidence: special, checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  const roundTripped = JSON.parse(JSON.stringify(out));
  assert.deepEqual(roundTripped, out);
  assert.equal(out.ledger_resolved[0].evidence, special);
});

// 7. 不変性
test('buildResolvedEvidence: 入力を Object.freeze しても throw せず、呼び出し後も入力は不変', () => {
  const blockingItems = deepFreeze([
    { id: 'B6', text: 'frozen text', evidence: 'frozen evidence', checked: true, dimension: 'quality' },
  ]);
  const advisoryItems = deepFreeze([
    { id: 'A6', text: 'frozen advisory', evidence: 'frozen ev', checked: true, dimension: 'quality' },
  ]);
  const acResults = deepFreeze([
    { ac_index: 0, satisfied: true, evidence: 'frozen ac ev', verified_by: 'test' },
  ]);
  const blockingSnapshot = JSON.parse(JSON.stringify(blockingItems));
  const advisorySnapshot = JSON.parse(JSON.stringify(advisoryItems));
  const acSnapshot = JSON.parse(JSON.stringify(acResults));

  let out;
  assert.doesNotThrow(() => {
    out = buildResolvedEvidence({ blockingItems, advisoryItems, acResults });
  });
  assert.ok(out);
  assert.deepEqual(JSON.parse(JSON.stringify(blockingItems)), blockingSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(advisoryItems)), advisorySnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(acResults)), acSnapshot);
});

// 8. 決定性
test('buildResolvedEvidence: 同一入力2回でJSON.stringifyがbyte一致', () => {
  const blockingItems = [
    { id: 'B7', text: 'det text', evidence: 'det evidence', checked: true, dimension: 'quality' },
  ];
  const advisoryItems = [
    { id: 'A7', text: 'det advisory', evidence: 'det ev', checked: true, dimension: 'quality' },
    { id: 'E7', text: 'env det', evidence: 'env ev', checked: true, dimension: 'environment', env_key: 'bats-sandbox', env_count: 2 },
  ];
  const acResults = [
    { ac_index: 0, satisfied: true, evidence: 'ac ev', verified_by: 'test' },
  ];
  const out1 = buildResolvedEvidence({ blockingItems, advisoryItems, acResults });
  const out2 = buildResolvedEvidence({ blockingItems, advisoryItems, acResults });
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
});

// 9. evidence null
test('buildResolvedEvidence: evidence null の item は出力の evidence も null（空文字に変換しない）', () => {
  const blockingItems = [
    { id: 'B8', text: 'no evidence', evidence: null, checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.equal(out.ledger_resolved[0].evidence, null);
});

test('buildResolvedEvidence: evidence undefined の item も出力の evidence が null', () => {
  const blockingItems = [
    { id: 'B9', text: 'no evidence2', checked: true, dimension: 'quality' },
  ];
  const out = buildResolvedEvidence({ blockingItems, advisoryItems: [], acResults: [] });
  assert.equal(out.ledger_resolved[0].evidence, null);
});
