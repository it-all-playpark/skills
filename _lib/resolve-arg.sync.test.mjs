// Sync test: workflow inline コピーが canonical と byte 一致することを保証する。
//
// 背景: .claude/workflows/*.js は Claude Code の dynamic workflow ローダーが独自の
// VM コンテキストで評価する。ESM の import 文はそのコンテキストで使用できないため、
// resolvePositiveIntArg の関数本体を各 workflow ファイルに inline コピーしている。
// このテストはその手動同期の漏れを CI で検出するための安全網である。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
// canonical ソースから `function resolvePositiveIntArg ... }` ブロックを抽出
// (export キーワードを除いた関数本体を正規化して比較)
function extractFn(src) {
  const m = src.match(/function resolvePositiveIntArg\([\s\S]*?\n}/);
  if (!m) throw new Error('resolvePositiveIntArg が見つからない');
  return m[0].trim();
}
const canonical = extractFn(readFileSync(join(repoRoot, '_lib/resolve-arg.mjs'), 'utf8'));
for (const wf of ['.claude/workflows/dev-flow.js', '.claude/workflows/pr-iterate.js']) {
  test(`${wf} の inline resolver が canonical と byte 一致`, () => {
    const inlined = extractFn(readFileSync(join(repoRoot, wf), 'utf8'));
    assert.equal(inlined, canonical, `${wf} の inline コピーが _lib/resolve-arg.mjs と乖離している`);
  });
}
