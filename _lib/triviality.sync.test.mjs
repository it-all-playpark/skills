// Sync test: workflow の inline コピーが canonical と byte 一致することを保証する。
//
// 背景: .claude/workflows/dev-flow.js は dynamic workflow ローダーが独自の
// VM コンテキストで評価する。ESM の import 文はそのコンテキストで使用できないため、
// workflow VM が ESM import 不可のため classifyShape を inline コピーしており、
// 本テストが手動同期漏れを CI で検出する安全網。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// canonical ソースおよび inline コピーから `function classifyShape ... }` ブロックを抽出
function extractFn(src) {
  const m = src.match(/function classifyShape\([\s\S]*?\n}/);
  if (!m) throw new Error('classifyShape が見つからない');
  return m[0].trim();
}

// canonical ソースおよび inline コピーから `const SHAPE_RANK = {...};` を抽出
function extractConst(src) {
  const m = src.match(/const SHAPE_RANK = \{[^}]+\};/);
  if (!m) throw new Error('SHAPE_RANK が見つからない');
  return m[0].trim();
}

const canonical = extractFn(readFileSync(join(repoRoot, '_lib/triviality.mjs'), 'utf8'));
const canonicalRank = extractConst(readFileSync(join(repoRoot, '_lib/triviality.mjs'), 'utf8'));

for (const wf of ['.claude/workflows/dev-flow.js']) {
  test(`${wf} の inline コピーが canonical と byte 一致`, () => {
    const inlined = extractFn(readFileSync(join(repoRoot, wf), 'utf8'));
    assert.equal(inlined, canonical, `${wf} の inline コピーが _lib/triviality.mjs と乖離`);
  });

  test(`${wf} の SHAPE_RANK 定義が canonical と byte 一致`, () => {
    const inlinedRank = extractConst(readFileSync(join(repoRoot, wf), 'utf8'));
    assert.equal(inlinedRank, canonicalRank, `${wf} の SHAPE_RANK 定義が _lib/triviality.mjs と乖離`);
  });
}
