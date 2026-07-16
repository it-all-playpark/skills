// _lib/dev-improve-workflow.test.mjs
// dev-improve.js の構造 invariant。挙動の決定論部分は inline 元 canonical のテストが担保し、
// 構文・ロード安全性は workflow-load-smoke.test.mjs / workflow-inlines.sync.test.mjs が
// 自動カバーする（両テストは .claude/workflows/*.js を自動発見する）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanMarkers } from '../tools/sync-inlines.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, '.claude/workflows/dev-improve.js'), 'utf8');

test('dev-improve.js: meta name と 4 phase', () => {
  assert.match(src, /name: 'dev-improve'/);
  for (const t of ['Reconcile', 'Mine', 'Rank', 'File']) {
    assert.match(src, new RegExp(`title: '${t}'`));
  }
});

test('dev-improve.js: 必要な canonical が inline されている', () => {
  const sources = scanMarkers(src, 'dev-improve.js').map((m) => m.source).sort();
  assert.deepEqual(sources, [
    '_lib/improve-hypothesis.mjs',
    '_lib/improve-rank.mjs',
    '_lib/quality-model.mjs',
    '_lib/workflow-post-helpers.mjs',
  ]);
});

test('dev-improve.js: args.today を検証し Date 系 API を使わない', () => {
  assert.match(src, /args\?\.today/);
  assert.doesNotMatch(src, /\bDate\.now\b/);
  assert.doesNotMatch(src, /\bnew Date\b/);
  assert.doesNotMatch(src, /\bMath\.random\b/);
});

test('dev-improve.js: journal telemetry を --telemetry-json で記録する', () => {
  assert.match(src, /journal\.sh log dev-improve success --telemetry-json/);
});

test('dev-improve.js: 4 miner ソースが揃っている', () => {
  for (const key of ['doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal']) {
    assert.match(src, new RegExp(`key: '${key}'`));
  }
});
