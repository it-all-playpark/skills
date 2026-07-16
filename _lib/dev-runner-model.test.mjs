// Guard test: assert that Setup/Validate phases use dev-runner-haiku (model:haiku in frontmatter)
// and Analyze/PR phases use dev-runner (model:sonnet in frontmatter).
//
// Background:
//   .claude/workflows/dev-flow.js uses runtime-injected globals and cannot be imported
//   as an ESM module. Validation uses source-as-string regex — same strategy as
//   _lib/agent-effort.test.mjs.
//
//   Model selection is controlled via agent frontmatter (agentType switching), NOT via
//   opts.model in agent() calls. This aligns with AGENTS.md which states:
//   "workflow の agent() には effort 引数が無いため frontmatter で固定する。"
//   The same principle applies to model: use a dedicated agent definition with the
//   desired model in its frontmatter rather than passing opts.model (which may be inert).
//
// Design:
//   Setup    → agentType: 'dev-runner-haiku'  (model:haiku in .claude/agents/dev-runner-haiku.md)
//   Analyze  → agentType: 'dev-runner'         (model:sonnet in .claude/agents/dev-runner.md)
//   Validate → agentType: 'dev-runner-haiku'  (model:haiku in .claude/agents/dev-runner-haiku.md)
//   PR       → agentType: 'dev-runner'         (model:sonnet in .claude/agents/dev-runner.md)
//
// Guarantee scope:
//   These tests verify:
//     (a) which agentType each phase uses in dev-flow.js source
//     (b) which model each agent definition declares in its frontmatter
//   Runtime model selection is fully determined by the frontmatter: when agentType is
//   'dev-runner-haiku', Claude Code loads dev-runner-haiku.md which declares model:haiku.
//   No opts.model override is used, so there is no gap between source configuration and
//   actual runtime behavior.
//
// Run: npx vitest run _lib/dev-runner-model.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devRunnerPath = join(repoRoot, '.claude', 'agents', 'dev-runner.md');
const devRunnerHaikuPath = join(repoRoot, '.claude', 'agents', 'dev-runner-haiku.md');

const src = readFileSync(devFlowPath, 'utf8');
const devRunnerFrontmatter = readFileSync(devRunnerPath, 'utf8');
const devRunnerHaikuFrontmatter = readFileSync(devRunnerHaikuPath, 'utf8');

/**
 * Find the agent() option line in dev-flow.js that matches the given schema and label pattern.
 * Returns the matching line or null.
 */
function findAgentCallLine(source, schemaName, labelPattern) {
  const lines = source.split('\n');
  for (const line of lines) {
    if (line.includes(`schema: ${schemaName}`) && labelPattern.test(line)) {
      return line;
    }
  }
  return null;
}

// ---- Phase → agentType checks (dev-flow.js source) ----

// (1) Setup uses dev-runner-haiku
test("[dev-runner-model] Setup (schema:SETUP) uses agentType:'dev-runner-haiku'", () => {
  const line = findAgentCallLine(src, 'SETUP', /label:\s*'worktree'/);
  assert.ok(
    line !== null,
    "Could not find Setup agent() call (schema:SETUP, label:'worktree') in dev-flow.js",
  );
  assert.match(
    line,
    /agentType:\s*'dev-runner-haiku'/,
    `Setup phase should use agentType:'dev-runner-haiku', but found: ${line}`,
  );
});

// (2) Validate uses dev-runner-haiku
// F2 (runValidateLoop 統合) 後: label は ternary に抽象化されるため
// /label:`test#/ の代わりに schema:GREEN 行で test# の存在を確認する。
test("[dev-runner-model] Validate (schema:GREEN) uses agentType:'dev-runner-haiku'", () => {
  const line = findAgentCallLine(src, 'GREEN', /test#/);
  assert.ok(
    line !== null,
    "Could not find Validate agent() call (schema:GREEN, containing test#) in dev-flow.js",
  );
  assert.match(
    line,
    /agentType:\s*'dev-runner-haiku'/,
    `Validate phase should use agentType:'dev-runner-haiku', but found: ${line}`,
  );
});

// (3) Analyze uses dev-runner (not dev-runner-haiku)
test("[dev-runner-model] Analyze (schema:REQ) uses agentType:'dev-runner'", () => {
  const line = findAgentCallLine(src, 'REQ', /label:\s*`analyze#/);
  assert.ok(
    line !== null,
    "Could not find Analyze agent() call (schema:REQ, label:`analyze#...`) in dev-flow.js",
  );
  assert.match(
    line,
    /agentType:\s*'dev-runner'/,
    `Analyze phase should use agentType:'dev-runner', but found: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /agentType:\s*'dev-runner-haiku'/,
    `Analyze phase should NOT use agentType:'dev-runner-haiku', but found: ${line}`,
  );
});

// (4) PR uses dev-runner (not dev-runner-haiku)
test("[dev-runner-model] PR (schema:PRURL) uses agentType:'dev-runner'", () => {
  const line = findAgentCallLine(src, 'PRURL', /label:\s*`pr#/);
  assert.ok(
    line !== null,
    "Could not find PR agent() call (schema:PRURL, label:`pr#...`) in dev-flow.js",
  );
  assert.match(
    line,
    /agentType:\s*'dev-runner'/,
    `PR phase should use agentType:'dev-runner', but found: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /agentType:\s*'dev-runner-haiku'/,
    `PR phase should NOT use agentType:'dev-runner-haiku', but found: ${line}`,
  );
});

// ---- Frontmatter model checks (agent definition files) ----
// These verify that the declared agentType actually maps to the intended model.
// Since Claude Code loads agent definitions from .claude/agents/<agentType>.md,
// the frontmatter model: field is authoritative — no opts.model override gap exists.

// (5) dev-runner-haiku.md declares model:haiku
test('[dev-runner-model] dev-runner-haiku.md frontmatter declares model:haiku', () => {
  // Match "model: haiku" within the YAML frontmatter block (between --- delimiters)
  const frontmatterMatch = devRunnerHaikuFrontmatter.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(
    frontmatterMatch !== null,
    'dev-runner-haiku.md must have a YAML frontmatter block',
  );
  const frontmatter = frontmatterMatch[1];
  assert.match(
    frontmatter,
    /^model:\s*haiku\s*$/m,
    `dev-runner-haiku.md frontmatter should declare model:haiku, but found:\n${frontmatter}`,
  );
});

// (6) dev-runner.md declares model:sonnet
test('[dev-runner-model] dev-runner.md frontmatter declares model:sonnet', () => {
  const frontmatterMatch = devRunnerFrontmatter.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(
    frontmatterMatch !== null,
    'dev-runner.md must have a YAML frontmatter block',
  );
  const frontmatter = frontmatterMatch[1];
  assert.match(
    frontmatter,
    /^model:\s*sonnet\s*$/m,
    `dev-runner.md frontmatter should declare model:sonnet, but found:\n${frontmatter}`,
  );
});

// (7) No opts.model override in agent() calls — model is fully controlled by frontmatter
test('[dev-runner-model] No opts.model key in any dev-runner agent() call in dev-flow.js', () => {
  const lines = src.split('\n');
  const violations = lines.filter(
    (line) =>
      line.includes("agentType: 'dev-runner") &&
      /model:\s*'(haiku|sonnet|opus)'/.test(line),
  );
  assert.deepEqual(
    violations,
    [],
    `Found agent() calls with opts.model (should use agentType switching instead):\n${violations.join('\n')}`,
  );
});
