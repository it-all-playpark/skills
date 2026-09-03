import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  canonicalJsonBytes,
  sha256Hex,
  domainSeparatedDigest,
  computeReceiptId,
} from './trust-digest.mjs';

// ---- (1) canonicalJsonBytes: determinism ----

test('canonicalJsonBytes: object key を UTF-16 code unit 昇順で再帰 sort する', () => {
  assert.equal(
    canonicalJsonBytes({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );
});

test('canonicalJsonBytes: key 順序が異なる同値 object は byte 一致する', () => {
  const v1 = { b: 1, a: { d: 2, c: 3 } };
  const v2 = { a: { c: 3, d: 2 }, b: 1 };
  assert.equal(canonicalJsonBytes(v1), canonicalJsonBytes(v2));
});

test('canonicalJsonBytes: 配列は順序を保持する', () => {
  assert.equal(canonicalJsonBytes({ x: [3, 1, 2] }), '{"x":[3,1,2]}');
});

test('canonicalJsonBytes: 空白を含まない最小形', () => {
  assert.equal(canonicalJsonBytes({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
});

// ---- (2) canonicalJsonBytes: 非 JSON 値は throw ----

test('canonicalJsonBytes: undefined は throw', () => {
  assert.throws(() => canonicalJsonBytes(undefined), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: object 内の undefined field は throw（JSON.stringify の暗黙 drop を許さない）', () => {
  assert.throws(() => canonicalJsonBytes({ a: undefined }), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: NaN は throw', () => {
  assert.throws(() => canonicalJsonBytes({ a: NaN }), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: Infinity は throw', () => {
  assert.throws(() => canonicalJsonBytes({ a: Infinity }), /trust-digest: canonical化できない値/);
  assert.throws(() => canonicalJsonBytes({ a: -Infinity }), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: function は throw', () => {
  assert.throws(() => canonicalJsonBytes({ a: () => {} }), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: symbol は throw', () => {
  assert.throws(() => canonicalJsonBytes({ a: Symbol('x') }), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: bigint は throw', () => {
  assert.throws(() => canonicalJsonBytes({ a: 1n }), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: 循環参照は throw', () => {
  const circular = { a: 1 };
  circular.self = circular;
  assert.throws(() => canonicalJsonBytes(circular), /trust-digest: canonical化できない値/);
});

test('canonicalJsonBytes: 配列内の循環参照も throw', () => {
  const arr = [1, 2];
  arr.push(arr);
  assert.throws(() => canonicalJsonBytes({ a: arr }), /trust-digest: canonical化できない値/);
});

// ---- (3) sha256Hex ----

test('sha256Hex: sha256:<hex64> 形式を返す', () => {
  const h = sha256Hex('hello');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
});

test('sha256Hex: 同一入力は同一出力（determinism）', () => {
  assert.equal(sha256Hex('same-input'), sha256Hex('same-input'));
});

test('sha256Hex: 異なる入力は異なる出力', () => {
  assert.notEqual(sha256Hex('a'), sha256Hex('b'));
});

// ---- (4) domainSeparatedDigest: determinism を hex 定数でピン留め ----

test('domainSeparatedDigest: 固定 fixture の digest を hex 定数でピン留め（surfaceproof/1）', () => {
  const value = { b: 1, a: { d: 2, c: 3 } };
  assert.equal(
    domainSeparatedDigest('surfaceproof/1', value),
    'sha256:5e1c166d73ab29e4f47629bf4be4bd8012e4870105c70e1ac7ce0f8a71a5609c',
  );
});

test('domainSeparatedDigest: key 順序が異なる同値 payload でも同一 digest（determinism）', () => {
  const v1 = { b: 1, a: { d: 2, c: 3 } };
  const v2 = { a: { c: 3, d: 2 }, b: 1 };
  assert.equal(
    domainSeparatedDigest('surfaceproof/1', v1),
    domainSeparatedDigest('surfaceproof/1', v2),
  );
});

test('domainSeparatedDigest: 同一 payload でも domain が異なれば digest は異なる（AC-2: protocol 間差し替え防止）', () => {
  const value = { b: 1, a: { d: 2, c: 3 } };
  const spDigest = domainSeparatedDigest('surfaceproof/1', value);
  const esDigest = domainSeparatedDigest('evalseal/1', value);
  assert.notEqual(spDigest, esDigest);
  assert.equal(esDigest, 'sha256:540e4fd890e9934848e671d0b4b5a58e3b04eceed41034bd72533bf8790d4bda');
});

test('domainSeparatedDigest: domain が空文字は throw', () => {
  assert.throws(() => domainSeparatedDigest('', { a: 1 }), /trust-digest/);
});

test('domainSeparatedDigest: domain が非文字列は throw', () => {
  assert.throws(() => domainSeparatedDigest(null, { a: 1 }), /trust-digest/);
  assert.throws(() => domainSeparatedDigest(undefined, { a: 1 }), /trust-digest/);
  assert.throws(() => domainSeparatedDigest(123, { a: 1 }), /trust-digest/);
});

// ---- (5) computeReceiptId ----

test('computeReceiptId: receipt_id field を除外して計算する（receipt_id の値に依らず同一）', () => {
  const receiptA = { schema_version: 'surfaceproof/1', payload: { x: 1 }, receipt_id: 'sha256:old' };
  const receiptB = { schema_version: 'surfaceproof/1', payload: { x: 1 }, receipt_id: 'sha256:different' };
  assert.equal(computeReceiptId(receiptA), computeReceiptId(receiptB));
});

test('computeReceiptId: receipt_id が無くても同じ digest を返す', () => {
  const withId = { schema_version: 'surfaceproof/1', payload: { x: 1 }, receipt_id: 'sha256:whatever' };
  const withoutId = { schema_version: 'surfaceproof/1', payload: { x: 1 } };
  assert.equal(computeReceiptId(withId), computeReceiptId(withoutId));
});

test('computeReceiptId: schema_version が異なれば digest も異なる（domain 分離）', () => {
  const receiptSp = { schema_version: 'surfaceproof/1', payload: { x: 1 } };
  const receiptEs = { schema_version: 'evalseal/1', payload: { x: 1 } };
  assert.notEqual(computeReceiptId(receiptSp), computeReceiptId(receiptEs));
});

test('computeReceiptId: schema_version 欠落は throw', () => {
  assert.throws(() => computeReceiptId({ payload: { x: 1 } }), /trust-digest/);
});

test('computeReceiptId: schema_version が空文字は throw', () => {
  assert.throws(() => computeReceiptId({ schema_version: '', payload: { x: 1 } }), /trust-digest/);
});

test('computeReceiptId: receipt が非 object は throw', () => {
  assert.throws(() => computeReceiptId(null), /trust-digest/);
  assert.throws(() => computeReceiptId('not-an-object'), /trust-digest/);
});
