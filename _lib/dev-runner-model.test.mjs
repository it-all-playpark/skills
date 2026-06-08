// Guard test: assert that dev-runner agent() calls in dev-flow.js have the correct
// `model` setting for each phase.
//
// Background:
//   .claude/workflows/dev-flow.js is a dynamic workflow evaluated only inside the
//   Claude Code runtime (uses top-level await and runtime-injected globals), so it
//   cannot be imported as an ordinary ESM module. Validation is done by reading the
//   source as a string and asserting with regex — the same strategy used in
//   _lib/agent-effort.test.mjs.
//
// Verification targets (4 dev-runner agent() calls):
//   Setup    — { agentType: 'dev-runner', schema: SETUP,  label: 'worktree',      phase: 'Setup'    }
//   Analyze  — { agentType: 'dev-runner', schema: REQ,    label: `analyze#${...}`, phase: 'Analyze'  }
//   Validate — { agentType: 'dev-runner', schema: GREEN,  label: `test#${...}`,   phase: 'Validate' }
//   PR       — { agentType: 'dev-runner', schema: PRURL,  label: `pr#${...}`,     phase: 'PR'       }
//
// This issue adds model:'haiku' to Setup and Validate only.
// Analyze and PR remain without model (sonnet default — no model key).
//
// TDD status:
//   RED  — before editing dev-flow.js: Setup/Validate have no model key → cases (1)(2) FAIL
//   GREEN — after editing dev-flow.js to add model:'haiku' to Setup and Validate → all pass
//
// Run: node --test _lib/dev-runner-model.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

/**
 * Extract the single-line agent option object string that contains a given schema name
 * and label pattern from the dev-flow.js source.
 *
 * Strategy:
 *   Each dev-runner call has its options on a single line in the form:
 *     { agentType: 'dev-runner', schema: SCHEMA_NAME, label: '...', phase: '...' }
 *   We split source into lines and find the line matching both the schema name and
 *   the label pattern.
 *
 * @param {string} source - Full file contents
 * @param {string} schemaName - Schema variable name (e.g. 'SETUP', 'GREEN', 'REQ', 'PRURL')
 * @param {RegExp} labelPattern - Regex to match the label value portion of that line
 * @returns {string|null} The matching line, or null if not found
 */
function extractDevRunnerOptionLine(source, schemaName, labelPattern) {
  const lines = source.split('\n');
  for (const line of lines) {
    if (
      line.includes("agentType: 'dev-runner'") &&
      line.includes(`schema: ${schemaName}`) &&
      labelPattern.test(line)
    ) {
      return line;
    }
  }
  return null;
}

// (1) Setup: schema SETUP, label 'worktree' — should have model:'haiku'
test("[dev-runner-model] Setup (schema:SETUP, label:'worktree') has model:'haiku'", () => {
  const line = extractDevRunnerOptionLine(src, 'SETUP', /label:\s*'worktree'/);
  assert.ok(
    line !== null,
    "Could not find Setup dev-runner option line (schema:SETUP, label:'worktree') in dev-flow.js",
  );
  assert.match(
    line,
    /model:\s*'haiku'/,
    `Setup dev-runner call should have model:'haiku', but found: ${line}`,
  );
});

// (2) Validate: schema GREEN, label contains 'test#' — should have model:'haiku'
test("[dev-runner-model] Validate (schema:GREEN, label contains 'test#') has model:'haiku'", () => {
  const line = extractDevRunnerOptionLine(src, 'GREEN', /label:\s*`test#/);
  assert.ok(
    line !== null,
    "Could not find Validate dev-runner option line (schema:GREEN, label:`test#...`) in dev-flow.js",
  );
  assert.match(
    line,
    /model:\s*'haiku'/,
    `Validate dev-runner call should have model:'haiku', but found: ${line}`,
  );
});

// (3) Analyze: schema REQ, label contains 'analyze#' — should NOT have model:'haiku' (sonnet default)
test("[dev-runner-model] Analyze (schema:REQ, label contains 'analyze#') does NOT have model:'haiku'", () => {
  const line = extractDevRunnerOptionLine(src, 'REQ', /label:\s*`analyze#/);
  assert.ok(
    line !== null,
    "Could not find Analyze dev-runner option line (schema:REQ, label:`analyze#...`) in dev-flow.js",
  );
  assert.doesNotMatch(
    line,
    /model:\s*'haiku'/,
    `Analyze dev-runner call should NOT have model:'haiku' (sonnet default), but found: ${line}`,
  );
});

// (4) PR: schema PRURL, label contains 'pr#' — should NOT have model:'haiku' (sonnet default)
test("[dev-runner-model] PR (schema:PRURL, label contains 'pr#') does NOT have model:'haiku'", () => {
  const line = extractDevRunnerOptionLine(src, 'PRURL', /label:\s*`pr#/);
  assert.ok(
    line !== null,
    "Could not find PR dev-runner option line (schema:PRURL, label:`pr#...`) in dev-flow.js",
  );
  assert.doesNotMatch(
    line,
    /model:\s*'haiku'/,
    `PR dev-runner call should NOT have model:'haiku' (sonnet default), but found: ${line}`,
  );
});

// (5) Self-validation: ensure extractDevRunnerOptionLine() is not inert.
//     A synthetic source with model:'haiku' must be detected correctly.
//     This guards against the extractor silently failing to match anything.
test('[dev-runner-model][self-validation] extractDevRunnerOptionLine detects model key in synthetic source', () => {
  const syntheticSrc = [
    "  { agentType: 'dev-runner', schema: SETUP, label: 'worktree', model: 'haiku', phase: 'Setup' },",
    "  { agentType: 'dev-runner', schema: REQ, label: `analyze#${ISSUE}`, phase: 'Analyze' },",
  ].join('\n');

  const setupLine = extractDevRunnerOptionLine(syntheticSrc, 'SETUP', /label:\s*'worktree'/);
  assert.ok(
    setupLine !== null,
    'extractDevRunnerOptionLine should find the SETUP line in synthetic source',
  );
  assert.match(
    setupLine,
    /model:\s*'haiku'/,
    "extractDevRunnerOptionLine should detect model:'haiku' in synthetic SETUP line",
  );

  const reqLine = extractDevRunnerOptionLine(syntheticSrc, 'REQ', /label:\s*`analyze#/);
  assert.ok(
    reqLine !== null,
    'extractDevRunnerOptionLine should find the REQ line in synthetic source',
  );
  assert.doesNotMatch(
    reqLine,
    /model:\s*'haiku'/,
    "extractDevRunnerOptionLine should NOT detect model:'haiku' in synthetic REQ line (no model key)",
  );
});

// TDD status:
//   RED  — before dev-flow.js is edited: Setup and Validate have no model key.
//          Cases (1) and (2) will FAIL with "does not match /model:\\s*'haiku'/" errors.
//          Cases (3), (4), and (5) will PASS.
//   GREEN — after dev-flow.js is edited to add model:'haiku' to Setup and Validate:
//          All 5 cases PASS.
