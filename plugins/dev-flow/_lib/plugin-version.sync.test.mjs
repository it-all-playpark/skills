// _lib/plugin-version.sync.test.mjs
// TDD pin test: ensures _lib/plugin-version.mjs inline markers exist in both workflow files,
// and that the canonical PLUGIN_VERSION matches plugin.json's version (semver format).
//
// This test guards against:
//   - plugin.json version bump without updating _lib/plugin-version.mjs
//   - someone deleting the plugin-version marker zone and hand-writing const PLUGIN_VERSION again
//   - canonical drift (caught by workflow-inlines.sync.test.mjs per-zone tests once markers exist)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { scanMarkers } from '../../../tools/sync-inlines.mjs';
import { PLUGIN_VERSION } from '../_lib/plugin-version.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wfDir = join(repoRoot, '.claude', 'workflows');

const CANONICAL_SOURCE = '_lib/plugin-version.mjs';

// ── Canonical sanity ─────────────────────────────────────────────────────────
test('PLUGIN_VERSION matches plugin.json version', () => {
  const pluginJson = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(
    PLUGIN_VERSION,
    pluginJson.version,
    `PLUGIN_VERSION ('${PLUGIN_VERSION}') が plugin.json の version ('${pluginJson.version}') と一致しません。` +
    `plugin.json を上げたら _lib/plugin-version.mjs も上げて tools/sync-inlines.mjs --write を実行してください。`,
  );
});

test('PLUGIN_VERSION is semver-formatted', () => {
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(PLUGIN_VERSION),
    `PLUGIN_VERSION must match semver x.y.z format, got: ${JSON.stringify(PLUGIN_VERSION)}`,
  );
});

// ── Marker existence: dev-flow.js ────────────────────────────────────────────
test('dev-flow.js contains inline marker for _lib/plugin-version.mjs', () => {
  const wfSrc = readFileSync(join(wfDir, 'dev-flow.js'), 'utf8');
  const markers = scanMarkers(wfSrc, 'dev-flow.js');
  const found = markers.some(m => m.source === CANONICAL_SOURCE);
  assert.ok(
    found,
    `dev-flow.js: BEGIN/END inline marker for '${CANONICAL_SOURCE}' が見つかりません。` +
    `tools/sync-inlines.mjs --add _lib/plugin-version.mjs --into dev-flow.js --after '<anchor>' を実行してください。`,
  );
});

// ── Marker existence: pr-iterate.js ─────────────────────────────────────────
test('pr-iterate.js contains inline marker for _lib/plugin-version.mjs', () => {
  const wfSrc = readFileSync(join(wfDir, 'pr-iterate.js'), 'utf8');
  const markers = scanMarkers(wfSrc, 'pr-iterate.js');
  const found = markers.some(m => m.source === CANONICAL_SOURCE);
  assert.ok(
    found,
    `pr-iterate.js: BEGIN/END inline marker for '${CANONICAL_SOURCE}' が見つかりません。` +
    `tools/sync-inlines.mjs --add _lib/plugin-version.mjs --into pr-iterate.js --after '<anchor>' を実行してください。`,
  );
});
