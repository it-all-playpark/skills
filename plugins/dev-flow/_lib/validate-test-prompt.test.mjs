// VALIDATE_TEST_PROMPT の残存内容を pin する source-regex テスト（issue #553）。
// dev-flow.js の VALIDATE_TEST_PROMPT 定義ブロックを readFileSync + slice して検査する
// （既存 _lib/isolation-probe-wiring.test.mjs と同じ source-regex スタイル。VM sandbox は使わない）。
// 本ファイルは負 assert 用に 'trust-test-latest' というリテラルを意図的に含む
// （whitelist ベースの repo 全体 grep pin テスト（_lib/trust-residue-grep.test.mjs）の
// whitelist にこのファイルが含まれることで、grep pin と本テストの負 assert が両立する）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const devFlowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

function extractValidateTestPrompt() {
  const start = src.indexOf('const VALIDATE_TEST_PROMPT');
  assert.notStrictEqual(start, -1, 'const VALIDATE_TEST_PROMPT の宣言が見つからない');
  const end = src.indexOf('\nconst ', start);
  assert.notStrictEqual(end, -1, 'VALIDATE_TEST_PROMPT 定義ブロックの終端（次の const 宣言）が見つからない');
  return src.slice(start, end);
}

test('VALIDATE_TEST_PROMPT は絶対パスを先頭トークンとする bare 形での test 実行規約を含む', () => {
  const block = extractValidateTestPrompt();
  assert.match(block, /絶対パスを先頭トークンとする bare 形/, 'bare 形実行規約の文言が見つからない');
  assert.match(block, /前置は禁止/, '前置禁止の文言が見つからない');
});

test('VALIDATE_TEST_PROMPT は format/lint がこの phase の責務外であることを明示する', () => {
  const block = extractValidateTestPrompt();
  assert.match(block, /format\/lint はこの phase の責務外/, 'format/lint 責務外の文言が見つからない');
});

test('VALIDATE_TEST_PROMPT は EPERM 時に 1 回だけ再試行して報告する規約を含む', () => {
  const block = extractValidateTestPrompt();
  assert.match(block, /EPERM/, 'EPERM への言及が見つからない');
  assert.match(block, /1 回だけ試し/, '1 回だけ再試行する規約の文言が見つからない');
});

test('VALIDATE_TEST_PROMPT は末尾で EPOCH_INSTRUCTION を連結している', () => {
  const block = extractValidateTestPrompt();
  assert.match(block, /EPOCH_INSTRUCTION/, 'EPOCH_INSTRUCTION 参照が block 内に残っていない');
});

test('VALIDATE_TEST_PROMPT は trust-test-latest.json への証跡保存ブロックを含まない（issue #553: 読み手不在のため除去）', () => {
  const block = extractValidateTestPrompt();
  assert.doesNotMatch(block, /trust-test-latest/, 'trust-test-latest への言及が残っている（証跡保存ブロックの除去漏れ）');
});

test('VALIDATE_TEST_PROMPT は「証跡保存」という語を含まない', () => {
  const block = extractValidateTestPrompt();
  assert.doesNotMatch(block, /証跡保存/, '証跡保存という語が残っている（証跡保存ブロックの除去漏れ）');
});

test('VALIDATE_TEST_PROMPT は Write tool による JSON 保存指示を含まない', () => {
  const block = extractValidateTestPrompt();
  assert.doesNotMatch(block, /Write tool/, 'Write tool への言及が残っている（証跡保存ブロックの除去漏れ）');
});
