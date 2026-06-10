// Sync test: workflow inline コピーが canonical と byte 一致することを保証する。
//
// 背景: .claude/workflows/dev-flow.js は Claude Code の dynamic workflow ローダーが
// 独自の VM コンテキストで評価する。ESM の import 文はそのコンテキストで使用できないため、
// buildDevflowSummaryBody の関数本体を dev-flow.js に inline コピーしている。
// このテストはその手動同期の漏れを CI で検出するための安全網である。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function extractFn(src, fnName) {
  const m = src.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${fnName} が見つからない`);
  return m[0].trim();
}

const fnName = 'buildDevflowSummaryBody';
const canonicalSrc = readFileSync(join(repoRoot, '_lib/devflow-summary-format.mjs'), 'utf8');
const canonical = extractFn(canonicalSrc, fnName);

test(`.claude/workflows/dev-flow.js の inline ${fnName} が canonical と byte 一致`, () => {
  const inlinedSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const inlined = extractFn(inlinedSrc, fnName);
  assert.equal(inlined, canonical, `.claude/workflows/dev-flow.js の inline コピー ${fnName} が _lib/devflow-summary-format.mjs と乖離している`);
});
