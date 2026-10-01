// _lib/evaluator-prompt-trim.test.mjs
// evaluator.md を目的と理由で書いた簡素版に保つための静的 pin。
// 煽り文・命令語の太字・issue 番号・orchestrator 内部の説明・meta ラベル・本文と重複する「原則」節を戻さない
// （replay で簡素版が verdict / major 再現で劣らないことを確認済み。詳細は git log）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(repoRoot, 'agents/evaluator.md'), 'utf8');
const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');

test('evaluator.md: Adversarial Opener 節と太字の強調が無い', () => {
  assert.ok(!body.includes('Adversarial Opener'));
  assert.ok(!/\*\*[^*\n]+\*\*/.test(body), '太字の強調が残っている');
});

test('evaluator.md: issue 番号を本文に書かない', () => {
  assert.deepEqual(body.match(/#\d+/g) ?? [], []);
});

test('evaluator.md: 収束の orchestrator 内部説明節・規範性クラスの meta ラベル・原則節が無い', () => {
  assert.ok(!body.includes('収束は orchestrator が最終判断する'));
  assert.ok(!body.includes('規範性クラス'));
  assert.ok(!/^## 原則/m.test(body));
});

test('evaluator.md: 2 回目以降の節が収束判断を呼び出し側に委ねる 1 文を持つ', () => {
  assert.match(body, /^## 2 回目以降/m);
  assert.ok(body.includes('収束の判断は呼び出し側が行う'));
});
