// _lib/workflow-inlines.sync.test.mjs
// Integration test: each inline zone in every .claude/workflows/*.js matches
// transformCanonical(readFileSync(sourcePath)) byte-for-byte.
//
// Replaces the 8 per-canonical sync tests that used fragile function-name extraction.
// Uses scanMarkers / transformCanonical from tools/sync-inlines.mjs (the same logic
// used by the generator) so the test and the writer share a single implementation.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { scanMarkers, transformCanonical } from '../tools/sync-inlines.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wfDir = join(repoRoot, '.claude', 'workflows');

// -----------------------------------------------------------------------------
// Helper: extract the inline zone body (lines between BEGIN and END, exclusive)
// from the workflow source as a single string (with trailing newline normalised).
// -----------------------------------------------------------------------------
function extractZoneBody(wfSrc, marker) {
  const lines = wfSrc.split('\n');
  // Lines between beginLine+1 and endLine-1 (inclusive) are the zone body.
  const bodyLines = lines.slice(marker.beginLine + 1, marker.endLine);
  return bodyLines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// Discover all *.js workflow files
// -----------------------------------------------------------------------------
const wfFiles = readdirSync(wfDir)
  .filter(f => f.endsWith('.js'))
  .sort();

// -----------------------------------------------------------------------------
// AC-3 invariant: both dev-flow.js and pr-iterate.js must have at least 1 marker.
// This guards against "someone deleted all BEGIN/END markers" hand-edits.
// (Listing these 2 filenames is not a function-name enumeration -- the invariant
// is about the presence of markers in each file, not about which canonicals exist.)
// -----------------------------------------------------------------------------
for (const requiredWf of ['dev-flow.js', 'pr-iterate.js']) {
  test(`${requiredWf} has at least 1 BEGIN inline marker`, () => {
    const wfSrc = readFileSync(join(wfDir, requiredWf), 'utf8');
    const markers = scanMarkers(wfSrc, requiredWf);
    assert.ok(
      markers.length >= 1,
      `${requiredWf}: BEGIN inline マーカーが 1 個以上必要です（全削除は禁止）`,
    );
  });
}

// -----------------------------------------------------------------------------
// Per-zone tests: dynamically generated for every marker found in every workflow.
// Each test asserts byte-for-byte equality between the zone body and
// transformCanonical(readFileSync(canonicalPath)).
// -----------------------------------------------------------------------------
for (const wfFile of wfFiles) {
  const wfPath = join(wfDir, wfFile);
  const wfSrc = readFileSync(wfPath, 'utf8');
  const markers = scanMarkers(wfSrc, wfFile);

  for (const marker of markers) {
    const { source } = marker;
    test(`${wfFile}: inline zone '${source}' matches transformCanonical`, () => {
      const canonicalSrc = readFileSync(join(repoRoot, source), 'utf8');
      const expected = transformCanonical(canonicalSrc, source);
      const actual = extractZoneBody(wfSrc, marker);
      assert.equal(
        actual,
        expected,
        `${wfFile} の inline 区間 '${source}' が canonical と乖離しています。` +
        `inline 区間は生成物 — _lib 側を編集して tools/sync-inlines.mjs --write を実行`,
      );
    });
  }
}
