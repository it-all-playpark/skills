import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdCell } from './md-cell.mjs';

test('mdCell(null) === ""', () => {
  assert.equal(mdCell(null), '');
});

test('mdCell(undefined) === ""', () => {
  assert.equal(mdCell(undefined), '');
});

test('mdCell("a|b") === "a\\\\|b" — パイプ文字をエスケープ', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
});

test('mdCell("a\\nb") === "a<br>b" — LF 改行を <br> に変換', () => {
  assert.equal(mdCell('a\nb'), 'a<br>b');
});

test('mdCell("a\\r\\nb") === "a<br>b" — CRLF 改行を <br> に変換', () => {
  assert.equal(mdCell('a\r\nb'), 'a<br>b');
});

test('mdCell(42) === "42" — 数値を文字列化', () => {
  assert.equal(mdCell(42), '42');
});

test('mdCell("hello world") === "hello world" — 通常文字列はそのまま', () => {
  assert.equal(mdCell('hello world'), 'hello world');
});
