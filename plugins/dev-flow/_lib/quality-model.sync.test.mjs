// _lib/quality-model.sync.test.mjs
// _lib/quality-model.mjs（QUALITY_MODEL）は dev-improve.js の rank-judge 専用。inline marker は
// dev-improve.js にのみ存在し、dev-flow.js / pr-iterate.js には無い（両 workflow の品質ゲート agent は
// frontmatter 既定で spawn する — review-model-frontmatter.test.mjs が pin）。
//
// This test guards against:
//   - someone deleting the dev-improve marker zone and hand-writing const QUALITY_MODEL again
//   - the marker zone being re-added to dev-flow.js / pr-iterate.js (fallback 機構の再導入)
//   - canonical drift (caught by workflow-inlines.sync.test.mjs per-zone tests once markers exist)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { scanMarkers } from '../../../tools/sync-inlines.mjs';
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

// ── Marker existence: dev-improve.js ─────────────────────────────────────────
test('dev-improve.js contains inline marker for _lib/quality-model.mjs', () => {
  const wfSrc = readFileSync(join(wfDir, 'dev-improve.js'), 'utf8');
  const markers = scanMarkers(wfSrc, 'dev-improve.js');
  const found = markers.some(m => m.source === CANONICAL_SOURCE);
  assert.ok(
    found,
    `dev-improve.js: BEGIN/END inline marker for '${CANONICAL_SOURCE}' が見つかりません。` +
    `手書き const QUALITY_MODEL を marker 区間に置換して tools/sync-inlines.mjs --write を実行してください。`,
  );
});

// ── Marker absence: dev-flow.js / pr-iterate.js ──────────────────────────────
test('dev-flow.js / pr-iterate.js do not contain inline marker for _lib/quality-model.mjs', () => {
  for (const wf of ['dev-flow.js', 'pr-iterate.js']) {
    const wfSrc = readFileSync(join(wfDir, wf), 'utf8');
    const markers = scanMarkers(wfSrc, wf);
    assert.ok(
      !markers.some(m => m.source === CANONICAL_SOURCE),
      `${wf}: '${CANONICAL_SOURCE}' の inline marker が再導入されている。品質ゲート agent の model は frontmatter で決める`,
    );
  }
});
