// Guard test: assert that all 6 dev-flow quality-gate agents have the expected
// `effort` value in their YAML frontmatter.
//
// TDD workflow:
//   RED  — before editing the 4 agent files, dev-planner/plan-reviewer/evaluator/pr-reviewer
//           will have `effort: max` which differs from the expected `high`.
//   GREEN — after the 4 files are edited, all 6 agents should assert to `high`.
//
// Run: npx vitest run _lib/agent-effort.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * Extract the `effort` value from the YAML frontmatter of a SKILL.md / agent .md source string.
 *
 * Strategy:
 *   1. Extract the frontmatter block between the first `---\n` ... `\n---` delimiters.
 *   2. Within that block only, match `^effort: <value>` (multiline).
 *
 * This ensures that occurrences of the word "effort" in the document body are not
 * mistakenly matched.
 *
 * @param {string} src - Full file contents
 * @returns {string|null} The effort value, or null if not found
 */
function frontmatterEffort(src) {
  const fmMatch = src.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fmBlock = fmMatch[1];
  const effortMatch = fmBlock.match(/^effort:\s*(\S+)/m);
  if (!effortMatch) return null;
  return effortMatch[1];
}

function readAgent(name) {
  const filePath = join(repoRoot, '.claude', 'agents', name + '.md');
  return readFileSync(filePath, 'utf8');
}

/**
 * Extract the `tools` list from the YAML frontmatter of an agent .md source string.
 *
 * Strategy:
 *   1. Extract the frontmatter block between the first `---\n` ... `\n---` delimiters.
 *   2. Within that block only, match the `tools:` block and collect each `  - <item>` line
 *      until a non-list line (or end of block) is reached.
 *
 * @param {string} src - Full file contents
 * @returns {string[]|null} The tools list, or null if not found
 */
function frontmatterTools(src) {
  const fmMatch = src.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fmBlock = fmMatch[1];
  const toolsMatch = fmBlock.match(/^tools:\n((?:^ {2}- .+\n?)+)/m);
  if (!toolsMatch) return null;
  return toolsMatch[1]
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^ {2}- /, '').trim());
}

// Table-driven: expected effort for each of the 6 dev-flow agents
const EXPECTED = {
  'dev-planner': 'high',
  'plan-reviewer': 'high',
  'evaluator': 'high',
  'pr-reviewer': 'high',
  'implementer': 'high',
  'dev-runner': 'high',
  'dev-runner-haiku-wo': 'low',
};

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`[agent-effort] .claude/agents/${name}.md: effort should be "${want}"`, () => {
    const src = readAgent(name);
    const got = frontmatterEffort(src);
    assert.equal(
      got,
      want,
      `Expected .claude/agents/${name}.md to have effort: ${want}, but got: ${got}`,
    );
  });
}

// Negative / self-validation test: ensure frontmatterEffort() is not inert.
// A synthetic source with `effort: max` must return 'max', not null or something else.
// This guards against the extractor silently returning a wrong value.
test('[agent-effort][negative] frontmatterEffort extracts "max" from synthetic source', () => {
  const synthetic = '---\neffort: max\n---\nbody';
  const got = frontmatterEffort(synthetic);
  assert.equal(
    got,
    'max',
    `frontmatterEffort should return 'max' for synthetic source, got: ${got}`,
  );
});

// Static pin (AC-3, issue #521): dev-runner-haiku-wo must have `tools` limited to
// exactly `[Write]` — no Bash/Read/Edit/Skill. This is a harness-level guarantee
// that the isolation probe cannot succeed through any Bash-redirect fallback path;
// prompt-only prohibition is not deterministic enough (an LLM can still improvise
// a Bash workaround if Bash is available).
test('[agent-effort][tools-pin] .claude/agents/dev-runner-haiku-wo.md: tools should be exactly [Write]', () => {
  const src = readAgent('dev-runner-haiku-wo');
  const got = frontmatterTools(src);
  assert.deepEqual(
    got,
    ['Write'],
    `Expected .claude/agents/dev-runner-haiku-wo.md tools to be exactly [Write], but got: ${JSON.stringify(got)}`,
  );
  for (const forbidden of ['Bash', 'Read', 'Skill', 'Edit']) {
    assert.ok(
      !got.includes(forbidden),
      `dev-runner-haiku-wo.md tools must not include "${forbidden}" (Bash fallback would defeat the isolation probe's purpose)`,
    );
  }
});
