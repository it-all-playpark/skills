// Guard test: assert that Setup/Validate phases use dev-runner-haiku (model:haiku in frontmatter)
// and the Analyze phase uses dev-runner (model:sonnet in frontmatter).
//
// Background:
//   .claude/workflows/dev-flow.js uses runtime-injected globals and cannot be imported
//   as an ESM module. Phase → agentType checks run dev-flow.js in the VM sandbox and
//   observe the {label, agentType, opts} actually passed to agent() (issue #636: replaced the
//   former source-as-string regex scan).
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
//   PR       → agentType: 'dev-runner-haiku'  (model:haiku in .claude/agents/dev-runner-haiku.md, issue #642)
//
// Guarantee scope:
//   These tests verify:
//     (a) which agentType each phase dispatches at runtime (VM-observed agent() calls)
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
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devRunnerPath = join(repoRoot, '.claude', 'agents', 'dev-runner.md');
const devRunnerHaikuPath = join(repoRoot, '.claude', 'agents', 'dev-runner-haiku.md');

const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const devRunnerFrontmatter = readFileSync(devRunnerPath, 'utf8');
const devRunnerHaikuFrontmatter = readFileSync(devRunnerHaikuPath, 'utf8');

let sharedCalls = null;
async function calls() {
  if (sharedCalls) return sharedCalls;
  const { ctx, calls: c } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-runner-model');
  assert.equal(error, null, `dev-flow.js の既定 run が throw した: ${error?.message}`);
  sharedCalls = c;
  return c;
}

function findCall(all, labelPattern) {
  return all.find((c) => labelPattern.test(c.label)) ?? null;
}

// ---- Phase → agentType checks (VM-observed dispatch) ----

// (1) Setup uses dev-runner-haiku
test("[dev-runner-model] Setup (label:'isolation-probe') dispatches agentType:'dev-runner-haiku-wo'", async () => {
  const c = findCall(await calls(), /^isolation-probe$/);
  assert.ok(c, "Setup の agent() 呼び出し（label:'isolation-probe'）が観測されない");
  assert.equal(c.agentType, 'dev-flow:dev-runner-haiku-wo', `Setup phase should use dev-runner-haiku-wo, but found: ${c.agentType}`);
});

// (2) Validate uses dev-runner-haiku
test("[dev-runner-model] Validate (label:'test#1') dispatches agentType:'dev-runner-haiku'", async () => {
  const c = findCall(await calls(), /^test#1$/);
  assert.ok(c, "Validate の agent() 呼び出し（label:'test#1'）が観測されない");
  assert.equal(c.agentType, 'dev-flow:dev-runner-haiku', `Validate phase should use dev-runner-haiku, but found: ${c.agentType}`);
});

// (3) Analyze uses dev-runner (not dev-runner-haiku)
test("[dev-runner-model] Analyze (label:'analyze#…') dispatches agentType:'dev-runner'", async () => {
  const c = findCall(await calls(), /^analyze#/);
  assert.ok(c, "Analyze の agent() 呼び出し（label:'analyze#…'）が観測されない");
  assert.equal(c.agentType, 'dev-flow:dev-runner', `Analyze phase should use dev-runner (not haiku), but found: ${c.agentType}`);
});

// (4) PR uses dev-runner-haiku (issue #642: commit message / PR body は workflow 側の純関数で確定し、
//     agent は verbatim 転写 + bare 単文 git/gh のみを担う exec-proxy になった)
test("[dev-runner-model] PR (label:'pr#…') dispatches agentType:'dev-runner-haiku'", async () => {
  const c = findCall(await calls(), /^pr#/);
  assert.ok(c, "PR の agent() 呼び出し（label:'pr#…'）が観測されない");
  assert.equal(c.agentType, 'dev-flow:dev-runner-haiku', `PR phase should use dev-runner-haiku (issue #642), but found: ${c.agentType}`);
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

// (7) No opts.model override in dev-runner agent() calls — model is fully controlled by frontmatter
test('[dev-runner-model] No opts.model in any dev-runner* agent() dispatch in dev-flow.js', async () => {
  const violations = (await calls())
    .filter((c) => c.agentType.startsWith('dev-flow:dev-runner') && c.opts?.model !== undefined)
    .map((c) => `${c.label}: model=${JSON.stringify(c.opts.model)}`);
  assert.deepEqual(violations, [], `Found dev-runner agent() dispatches with opts.model (should use agentType switching instead):\n${violations.join('\n')}`);
});
