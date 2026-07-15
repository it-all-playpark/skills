// Guard test: structural-classify exec-proxy routing / fail-open / i===1 gating / realizedCount
// exclusion / schema fail-open tolerance (issue #350, task F2).
//
// Background:
//   dev-flow.js の Security floor phase は F1 の決定論 script
//   `_shared/scripts/structural-classify.sh` を dev-runner-haiku-ro exec-proxy 経由で呼び、
//   difftastic による structural / format_only 分類を取得する。この分類は advisory な
//   diff 前処理（diff-hash と同型）であり、失敗ポリシーは fail-open: struct が null /
//   ok:false / available:false / schema 不一致でも呼び出し元 need() で throw させず、
//   formatOnlySet を空にして現行動作（全ファイル structural 扱い相当）へフォールバックする。
//
//   .claude/workflows/*.js はランタイム注入 global を使うため ESM import できない。
//   よって _lib/exec-proxy-routing.test.mjs と同じ戦略 (source-as-string regex) で検証する。
//
// Run: node --test _lib/structural-classify-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

/**
 * Find the line in `source` whose `label:` value matches `labelLiteral` exactly
 * (closing quote immediately after, so 'structural-classify' does not accidentally
 * match a hypothetical 'structural-classify-final' etc).
 */
function findLineByExactLabel(source, labelLiteral) {
  const escaped = labelLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`label:\\s*'${escaped}'`);
  const lines = source.split('\n');
  for (const line of lines) {
    if (re.test(line)) return line;
  }
  return null;
}

// ---- (1) routing: label 'structural-classify' -> agentType:'dev-runner-haiku-ro' ----

test("[structural-classify-routing] label 'structural-classify' routes to agentType:'dev-runner-haiku-ro'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'structural-classify');
  assert.ok(line !== null, "Could not find agent() call with label 'structural-classify' in dev-flow.js");
  assert.match(
    line,
    /agentType:\s*'dev-runner-haiku-ro'/,
    `label 'structural-classify' should route to agentType:'dev-runner-haiku-ro', but found: ${line}`,
  );
});

// ---- (2) fail-open: not wrapped in need() ----

test('[structural-classify-routing] structural-classify agent() call is NOT wrapped in need() (fail-open policy)', () => {
  const idx = devFlowSrc.indexOf("label: 'structural-classify'");
  assert.ok(idx !== -1, "Could not find label 'structural-classify' in dev-flow.js");
  const windowStart = Math.max(0, idx - 400);
  const before = devFlowSrc.slice(windowStart, idx);
  assert.doesNotMatch(
    before,
    /need\(\s*await agent\(/,
    'structural-classify call must not be wrapped in need() -- diff-hash-style fail-open policy required',
  );
  assert.match(
    before,
    /struct\s*=\s*await agent\(/,
    'expected a plain "struct = await agent(" assignment (not need-wrapped) preceding the structural-classify label',
  );
});

// ---- (3) fail-open: wrapped in try/catch so a thrown exception does not propagate ----

test('[structural-classify-routing] structural-classify call is wrapped in try/catch (fail-open on exception)', () => {
  const idx = devFlowSrc.indexOf("label: 'structural-classify'");
  assert.ok(idx !== -1);
  const before = devFlowSrc.slice(Math.max(0, idx - 400), idx);
  const after = devFlowSrc.slice(idx, idx + 400);
  assert.match(before, /try\s*\{/, 'expected a try { block before the structural-classify agent() call');
  assert.match(after, /\}\s*catch/, 'expected a catch block after the structural-classify agent() call');
});

// ---- (4) evaluator prompt injection is gated by i === 1 (same as focus_areas / ui_verification) ----

test('[structural-classify-routing] diff_classification prompt injection is gated by i === 1', () => {
  assert.match(
    devFlowSrc,
    /i === 1 && state\.diffClassification/,
    'diff_classification injection into the evaluator prompt must be gated by "i === 1 && state.diffClassification" '
    + '(iteration 2+ must not reuse a stale classification, per focus_areas/ui_verification precedent)',
  );
});

// ---- (5) realizedCount excludes format_only files ----

test('[structural-classify-routing] realizedCount computation excludes format_only files via formatOnlySet', () => {
  assert.match(devFlowSrc, /formatOnlySet/, 'expected a formatOnlySet to be derived from the structural-classify result');
  assert.match(
    devFlowSrc,
    /formatOnlyExcluded/,
    'expected a formatOnlyExcluded count used to exclude format-only files from realizedCount and to log the exclusion',
  );
});

// ---- (6) STRUCT schema fail-open tolerance: required is ['ok'] only ----

test("[structural-classify-routing] STRUCT schema requires only 'ok' (missing 'available' must not be a schema error)", () => {
  const idx = devFlowSrc.indexOf('const STRUCT');
  assert.ok(idx !== -1, 'Could not find STRUCT schema definition in dev-flow.js');
  const window = devFlowSrc.slice(idx, idx + 300);
  assert.match(
    window,
    /required:\s*\[\s*'ok'\s*\]/,
    `STRUCT schema 'required' should be ['ok'] only (fail-open tolerance), got window: ${window}`,
  );
});

// ---- (7) state.diffClassification is persisted for the i===1 evaluator prompt to consume ----

test('[structural-classify-routing] state.diffClassification is assigned in execSecurityFloorPhase', () => {
  assert.match(
    devFlowSrc,
    /state\.diffClassification\s*=/,
    'expected state.diffClassification to be assigned so the Evaluate phase can read it',
  );
});
