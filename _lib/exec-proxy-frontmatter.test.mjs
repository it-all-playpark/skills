// Guard test: exec-proxy agent frontmatter — capability 3層分離 (issue #323, task F2/F3).
//
// Background:
//   dev-flow / pr-iterate の決定論 exec-proxy 呼び出しは capability 別に 3 agent へ分離する
//   (architecture_decisions 参照):
//     - dev-runner-haiku-ro (新設): read-only 決定論 proxy 専任。tools: [Bash, Read] のみ。
//       Write/Edit/Skill/TodoWrite/Glob/Grep を持たない (least privilege)。
//     - dev-runner-haiku: write/Skill 系 proxy 専任。tools: [Bash, Read, Skill] のみ。
//       Write/Edit/Glob/Grep/TodoWrite を除去する (Write 除去が本 issue の要点)。
//     - dev-runner: 判断寄り (fix/analyze) を担う sonnet agent。tools から TodoWrite のみ除去。
//       Write/Edit は post-summary 等の実要求があるため残置。
//
//   effort は F1 の A/B 実測 (claudedocs/2026-07-12-issue-323-exec-proxy-effort-ab.md) で
//   決定した adopted_effort をそのまま使う。mechanical exec-proxy (dev-runner-haiku-ro /
//   dev-runner-haiku) は adopted_effort、dev-runner (sonnet, 推論を要する) は
//   本測定の対象外で effort: high 据え置き。
//
//   maxTurns は全 exec-proxy agent に有限値を設定する (AC-2)。runtime honor の実効性確認は
//   別途 F3 implementer summary の concern として報告される (source frontmatter のみでは
//   runtime が honor するかまでは検証できないため、本テストは有限性のみを検証する)。
//
// Design:
//   このテストは .claude/agents/ の 3 ファイルの YAML frontmatter を正規表現で検証する。
//   既存 _lib/dev-runner-model.test.mjs と同じ抽出パターン
//   (`/^---\n([\s\S]*?)\n---/` でフロントマター本文を切り出す) を踏襲する。
//
// Run: npx vitest run _lib/exec-proxy-frontmatter.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const agentsDir = join(repoRoot, '.claude', 'agents');

// F1 A/B 実測 (claudedocs/2026-07-12-issue-323-exec-proxy-effort-ab.md) の adopted_effort。
// mechanical exec-proxy (dev-runner-haiku-ro / dev-runner-haiku) に適用する値。
const ADOPTED_EFFORT = 'low';

/**
 * Extract the YAML frontmatter body (between the --- delimiters) from a markdown source.
 * Returns null if no frontmatter block is found.
 */
function extractFrontmatter(source) {
  const m = source.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/**
 * Extract the `tools:` YAML list from a frontmatter body.
 * Returns an array of tool name strings (empty array if no tools: block found).
 */
function extractToolsList(frontmatter) {
  const m = frontmatter.match(/^tools:\n((?:[ \t]*-[ \t]*\S+\n?)+)/m);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-\s*/, '').trim());
}

/**
 * Load an agent .md file and return { path, exists, source, frontmatter }.
 * Never throws — missing files/frontmatter are represented as null so individual
 * assertions produce clear failures instead of aborting the whole test file.
 */
function loadAgent(fileName) {
  const path = join(agentsDir, fileName);
  const exists = existsSync(path);
  const source = exists ? readFileSync(path, 'utf8') : null;
  const frontmatter = source ? extractFrontmatter(source) : null;
  return { path, exists, source, frontmatter };
}

// ---- (a) dev-runner-haiku-ro.md ----

test('[exec-proxy-frontmatter] dev-runner-haiku-ro.md exists', () => {
  const { exists, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(exists, `Expected agent definition to exist at ${path}`);
});

test('[exec-proxy-frontmatter] dev-runner-haiku-ro.md has a YAML frontmatter block', () => {
  const { exists, frontmatter, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(exists, `Expected agent definition to exist at ${path}`);
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
});

test('[exec-proxy-frontmatter] dev-runner-haiku-ro.md declares model:haiku', () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^model:\s*haiku\s*$/m,
    `dev-runner-haiku-ro.md frontmatter should declare model:haiku, but found:\n${frontmatter}`,
  );
});

test(`[exec-proxy-frontmatter] dev-runner-haiku-ro.md declares effort:${ADOPTED_EFFORT} (F1 adopted_effort)`, () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  const re = new RegExp(`^effort:\\s*${ADOPTED_EFFORT}\\s*$`, 'm');
  assert.match(
    frontmatter,
    re,
    `dev-runner-haiku-ro.md frontmatter should declare effort:${ADOPTED_EFFORT} `
      + `(per claudedocs/2026-07-12-issue-323-exec-proxy-effort-ab.md adopted_effort), `
      + `but found:\n${frontmatter}`,
  );
});

test('[exec-proxy-frontmatter] dev-runner-haiku-ro.md tools is exactly [Bash, Read]', () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  const tools = extractToolsList(frontmatter);
  assert.deepEqual(
    [...tools].sort(),
    ['Bash', 'Read'],
    `dev-runner-haiku-ro.md tools should be exactly [Bash, Read], but found: ${JSON.stringify(tools)}`,
  );
  for (const forbidden of ['Write', 'Edit', 'Skill', 'TodoWrite', 'Glob', 'Grep']) {
    assert.ok(
      !tools.includes(forbidden),
      `dev-runner-haiku-ro.md tools must NOT include ${forbidden} (read-only exec-proxy), but found: ${JSON.stringify(tools)}`,
    );
  }
});

test('[exec-proxy-frontmatter] dev-runner-haiku-ro.md declares a finite positive maxTurns', () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^maxTurns:\s*[1-9]\d*\s*$/m,
    `dev-runner-haiku-ro.md frontmatter should declare a finite positive maxTurns, but found:\n${frontmatter}`,
  );
});

// ---- (b) dev-runner-haiku.md ----

test('[exec-proxy-frontmatter] dev-runner-haiku.md declares model:haiku', () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^model:\s*haiku\s*$/m,
    `dev-runner-haiku.md frontmatter should declare model:haiku, but found:\n${frontmatter}`,
  );
});

test(`[exec-proxy-frontmatter] dev-runner-haiku.md declares effort:${ADOPTED_EFFORT} (F1 adopted_effort)`, () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  const re = new RegExp(`^effort:\\s*${ADOPTED_EFFORT}\\s*$`, 'm');
  assert.match(
    frontmatter,
    re,
    `dev-runner-haiku.md frontmatter should declare effort:${ADOPTED_EFFORT} `
      + `(per claudedocs/2026-07-12-issue-323-exec-proxy-effort-ab.md adopted_effort), `
      + `but found:\n${frontmatter}`,
  );
});

test('[exec-proxy-frontmatter] dev-runner-haiku.md tools is exactly [Bash, Read, Skill]', () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  const tools = extractToolsList(frontmatter);
  assert.deepEqual(
    [...tools].sort(),
    ['Bash', 'Read', 'Skill'],
    `dev-runner-haiku.md tools should be exactly [Bash, Read, Skill], but found: ${JSON.stringify(tools)}`,
  );
  for (const forbidden of ['Write', 'Edit', 'TodoWrite', 'Glob', 'Grep']) {
    assert.ok(
      !tools.includes(forbidden),
      `dev-runner-haiku.md tools must NOT include ${forbidden} (Write removal is the key change), but found: ${JSON.stringify(tools)}`,
    );
  }
});

test('[exec-proxy-frontmatter] dev-runner-haiku.md declares a finite positive maxTurns', () => {
  const { frontmatter, path } = loadAgent('dev-runner-haiku.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^maxTurns:\s*[1-9]\d*\s*$/m,
    `dev-runner-haiku.md frontmatter should declare a finite positive maxTurns, but found:\n${frontmatter}`,
  );
});

// ---- (c) dev-runner.md ----

test('[exec-proxy-frontmatter] dev-runner.md declares model:sonnet', () => {
  const { frontmatter, path } = loadAgent('dev-runner.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^model:\s*sonnet\s*$/m,
    `dev-runner.md frontmatter should declare model:sonnet, but found:\n${frontmatter}`,
  );
});

test('[exec-proxy-frontmatter] dev-runner.md declares effort:high (unchanged, out of A/B scope)', () => {
  const { frontmatter, path } = loadAgent('dev-runner.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^effort:\s*high\s*$/m,
    `dev-runner.md frontmatter should declare effort:high, but found:\n${frontmatter}`,
  );
});

test('[exec-proxy-frontmatter] dev-runner.md tools include Bash/Read/Write/Edit/Glob/Grep/Skill and exclude TodoWrite', () => {
  const { frontmatter, path } = loadAgent('dev-runner.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  const tools = extractToolsList(frontmatter);
  for (const required of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill']) {
    assert.ok(
      tools.includes(required),
      `dev-runner.md tools should include ${required}, but found: ${JSON.stringify(tools)}`,
    );
  }
  assert.ok(
    !tools.includes('TodoWrite'),
    `dev-runner.md tools must NOT include TodoWrite (removed), but found: ${JSON.stringify(tools)}`,
  );
});

test('[exec-proxy-frontmatter] dev-runner.md declares a finite positive maxTurns', () => {
  const { frontmatter, path } = loadAgent('dev-runner.md');
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  assert.match(
    frontmatter,
    /^maxTurns:\s*[1-9]\d*\s*$/m,
    `dev-runner.md frontmatter should declare a finite positive maxTurns, but found:\n${frontmatter}`,
  );
});
