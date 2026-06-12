// _lib/quality-model.sync.test.mjs
// TDD pin test: ensures _lib/quality-model.mjs inline markers exist in both workflow files,
// and that the canonical itself exports a non-empty QUALITY_MODEL string.
//
// This test guards against:
//   - someone deleting the quality-model marker zone and hand-writing const QUALITY_MODEL again
//   - canonical drift (caught by workflow-inlines.sync.test.mjs per-zone tests once markers exist)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { scanMarkers } from '../tools/sync-inlines.mjs';
import { QUALITY_MODEL } from '../_lib/quality-model.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wfDir = join(repoRoot, '.claude', 'workflows');

const CANONICAL_SOURCE = '_lib/quality-model.mjs';

// ── Canonical sanity ─────────────────────────────────────────────────────────
test('QUALITY_MODEL is a non-empty string', () => {
  assert.ok(
    typeof QUALITY_MODEL === 'string' && QUALITY_MODEL.length > 0,
    `QUALITY_MODEL must be a non-empty string, got: ${JSON.stringify(QUALITY_MODEL)}`,
  );
});

// ── Marker existence: dev-flow.js ────────────────────────────────────────────
test('dev-flow.js contains inline marker for _lib/quality-model.mjs', () => {
  const wfSrc = readFileSync(join(wfDir, 'dev-flow.js'), 'utf8');
  const markers = scanMarkers(wfSrc, 'dev-flow.js');
  const found = markers.some(m => m.source === CANONICAL_SOURCE);
  assert.ok(
    found,
    `dev-flow.js: BEGIN/END inline marker for '${CANONICAL_SOURCE}' が見つかりません。` +
    `手書き const QUALITY_MODEL を marker 区間に置換して tools/sync-inlines.mjs --write を実行してください。`,
  );
});

// ── Marker existence: pr-iterate.js ─────────────────────────────────────────
test('pr-iterate.js contains inline marker for _lib/quality-model.mjs', () => {
  const wfSrc = readFileSync(join(wfDir, 'pr-iterate.js'), 'utf8');
  const markers = scanMarkers(wfSrc, 'pr-iterate.js');
  const found = markers.some(m => m.source === CANONICAL_SOURCE);
  assert.ok(
    found,
    `pr-iterate.js: BEGIN/END inline marker for '${CANONICAL_SOURCE}' が見つかりません。` +
    `手書き const QUALITY_MODEL を marker 区間に置換して tools/sync-inlines.mjs --write を実行してください。`,
  );
});
