// Guard test: dev-flow.js の PLAN_RELAX_FROM 定数が 2 であることを保証する。
//
// 背景: PLAN_RELAX_FROM は Plan レビューループの収束緩和を開始する iteration 閾値。
// 3 → 2 への変更で往復回数を 1 減らす（issue #138）。
// dev-flow.js は VM コンテキストで評価されるため ESM import 不可。
// ソース文字列を regex 抽出する静的解析方式で検証する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const src = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

test('PLAN_RELAX_FROM の宣言が dev-flow.js に存在する', () => {
  const m = src.match(/const\s+PLAN_RELAX_FROM\s*=\s*(\d+)/);
  assert.ok(m, 'PLAN_RELAX_FROM の宣言が見つからない');
});

test('PLAN_RELAX_FROM は Plan ループ往復削減のため 2 であるべき', () => {
  const m = src.match(/const\s+PLAN_RELAX_FROM\s*=\s*(\d+)/);
  assert.ok(m, 'PLAN_RELAX_FROM の宣言が見つからない');
  assert.equal(Number(m[1]), 2, 'PLAN_RELAX_FROM は Plan ループ往復削減のため 2 であるべき');
});

test('収束判定ロジック iteration >= PLAN_RELAX_FROM が dev-flow.js に依然存在する', () => {
  assert.match(src, /iteration\s*>=\s*PLAN_RELAX_FROM/, '収束判定ロジックが消えている');
});
