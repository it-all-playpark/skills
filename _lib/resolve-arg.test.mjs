import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePositiveIntArg } from './resolve-arg.mjs';

test('bare string "120" を "120" に解決（HEAD の bare-string bug 回帰防止）', () => {
  assert.equal(resolvePositiveIntArg('120', 'issue'), '120');
});
test('number 120 を "120" に解決', () => {
  assert.equal(resolvePositiveIntArg(120, 'issue'), '120');
});
test('array ["119"] を "119" に解決', () => {
  assert.equal(resolvePositiveIntArg(['119'], 'issue'), '119');
});
test('object {issue:"116"} を "116" に解決', () => {
  assert.equal(resolvePositiveIntArg({ issue: '116' }, 'issue'), '116');
});
test('object {pr:"88"} を name=pr で "88" に解決', () => {
  assert.equal(resolvePositiveIntArg({ pr: '88' }, 'pr'), '88');
});
test('未展開テンプレート "{" は throw（本 issue の root cause）', () => {
  assert.throws(() => resolvePositiveIntArg('{', 'issue'), /正の整数/);
});
test('空文字は throw', () => {
  assert.throws(() => resolvePositiveIntArg('', 'issue'));
});
test('"0" は throw（正の整数のみ）', () => {
  assert.throws(() => resolvePositiveIntArg('0', 'issue'));
});
test('null/undefined は throw', () => {
  assert.throws(() => resolvePositiveIntArg(null, 'issue'));
  assert.throws(() => resolvePositiveIntArg(undefined, 'issue'));
});
