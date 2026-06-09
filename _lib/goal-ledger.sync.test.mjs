// Sync test: dev-flow.js の inline コピーが canonical (_lib/goal-ledger.mjs) と byte 一致することを保証する。
// 背景は _lib/resolve-arg.sync.test.mjs と同じ(workflow ローダーは ESM import 不可 → 手動 inline コピー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const FN_NAMES = [
  'makeLedger', 'laneOf', 'topicKey', 'canAppend', 'appendItem',
  'applySeverityFloor', 'mergeSeverity', 'checkItem', 'reopenItem',
  'setCheck', 'blockingItems', 'advisoryItems', 'isConverged', 'nextRound',
];

function extractFn(src, name) {
  const re = new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} が見つからない`);
  return m[0].replace(/^export /, '').trim();
}

const canonicalSrc = readFileSync(join(repoRoot, '_lib/goal-ledger.mjs'), 'utf8');
const wfSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

for (const name of FN_NAMES) {
  test(`dev-flow.js の inline ${name} が canonical と byte 一致`, () => {
    const canonical = extractFn(canonicalSrc, name);
    const inlined = extractFn(wfSrc, name);
    assert.equal(inlined, canonical, `${name} の inline コピーが _lib/goal-ledger.mjs と乖離している`);
  });
}
