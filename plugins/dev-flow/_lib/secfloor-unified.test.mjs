import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseSecfloorFields } from './secfloor-unified.mjs';

// (1) null 入力 → risk.ok===false かつ hits===[]、files/struct/hash は null。hits フィールド欠落を
// clean と同一視しない fail-closed が要件。
test('null 入力 → risk fail-closed (hits=[]), files/struct/hash=null', () => {
  const result = parseSecfloorFields(null);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.equal(typeof result.risk.error, 'string');
  assert.equal(result.files, null);
  assert.equal(result.struct, null);
  assert.equal(result.hash, null);
});

// (2) 全フィールド正常入力 → 全て素通し
test('全フィールド正常 → risk/files/struct/hash がすべて素通し', () => {
  const unified = {
    risk: { ok: true, hits: [{ file: 'a.js', class: 'exec', severity: 'critical' }] },
    files: ['a.js', 'b.js'],
    struct: { ok: true, available: true, structural: ['a.js'], format_only: ['b.js'] },
    diffhash: { hash: 'abc123', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.risk, unified.risk);
  assert.deepEqual(result.files, unified.files);
  assert.deepEqual(result.struct, unified.struct);
  assert.equal(result.hash, 'abc123');
});

// (3) risk のみ欠落/型不正（ok 非boolean・hits 非配列）→ risk fail-closed 合成だが
// files/struct/hash は正常値のまま（波及なし）
test('risk のみ型不正 → risk fail-closed だが他フィールドは無傷', () => {
  const unified = {
    risk: { ok: 'yes', hits: 'not-an-array' },
    files: ['a.js'],
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 'deadbeef', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.deepEqual(result.files, ['a.js']);
  assert.deepEqual(result.struct, unified.struct);
  assert.equal(result.hash, 'deadbeef');
});

test('risk 欠落フィールド（hits なし）→ risk fail-closed（hits 欠落を clean と同一視しない）', () => {
  const unified = {
    risk: { ok: true },
    files: [],
    struct: null,
    diffhash: { hash: 'x', empty: true },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.deepEqual(result.files, []);
  assert.equal(result.hash, 'x');
});

// (4) files のみ不正（非配列・string 混入なし要素）→ files null だが risk は正常のまま（波及なし）
test('files のみ非配列 → files null だが risk は無傷', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: 'not-an-array',
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 'x', empty: true },
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.equal(result.files, null);
  assert.deepEqual(result.struct, unified.struct);
  assert.equal(result.hash, 'x');
});

test('files に非 string 要素混入 → files null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js', 42, 'c.js'],
    struct: null,
    diffhash: null,
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.files, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
});

// (5) struct のみ不正/available:false → struct null/採用なしだが他フィールド不変
test('struct.ok!==true → struct null だが他フィールドは無傷', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    struct: { ok: false, error: 'boom' },
    diffhash: { hash: 'x', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.struct, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.deepEqual(result.files, ['a.js']);
  assert.equal(result.hash, 'x');
});

test('struct.available が boolean 以外 → struct null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    struct: { ok: true, available: 'true', structural: [], format_only: [] },
    diffhash: { hash: 'x', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.struct, null);
  assert.deepEqual(result.files, ['a.js']);
});

test('struct.available===false (difft 未インストール) は object かつ配列が揃っていれば採用', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    struct: { ok: true, available: false, structural: [], format_only: [], reason: 'difft_not_installed' },
    diffhash: null,
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.struct, unified.struct);
});

// (6) diffhash.hash 非string → hash null のみ
test('diffhash.hash が非 string → hash null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 12345, empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.hash, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.deepEqual(result.files, ['a.js']);
  assert.deepEqual(result.struct, unified.struct);
});

test('diffhash 欠落 → hash null', () => {
  const unified = { risk: { ok: true, hits: [] }, files: [], struct: null };
  const result = parseSecfloorFields(unified);
  assert.equal(result.hash, null);
});

// (7) files:[] は [] のまま（null と区別）
test('files:[] は null と区別され [] のまま採用される', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    struct: null,
    diffhash: null,
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.files, []);
  assert.notEqual(result.files, null);
});

// non-object / 任意の不正値入力（number, string, array）でも risk fail-closed、他 null に落ちる
test('unified が非 object（number）→ risk fail-closed、files/struct/hash=null', () => {
  const result = parseSecfloorFields(42);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.equal(result.files, null);
  assert.equal(result.struct, null);
  assert.equal(result.hash, null);
});

test('unified が undefined → risk fail-closed、files/struct/hash=null', () => {
  const result = parseSecfloorFields(undefined);
  assert.equal(result.risk.ok, false);
  assert.equal(result.files, null);
  assert.equal(result.struct, null);
  assert.equal(result.hash, null);
});
