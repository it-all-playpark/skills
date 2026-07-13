// _lib/improve-miner-frontmatter.test.mjs
// improve-miner agent frontmatter の invariant: read-only tools / model sonnet / effort high。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, '.claude/agents/improve-miner.md'), 'utf8');
const frontmatter = src.split('---')[1] ?? '';

test('improve-miner: name / model sonnet / effort high', () => {
  assert.match(frontmatter, /^name: improve-miner$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^effort: high$/m);
});

test('improve-miner: read-only tools（Write/Edit/Skill/TodoWrite を持たない）', () => {
  for (const tool of ['Bash', 'Read', 'Grep', 'Glob']) {
    assert.match(frontmatter, new RegExp(`^  - ${tool}$`, 'm'));
  }
  assert.doesNotMatch(frontmatter, /^  - (Write|Edit|Skill|TodoWrite)$/m);
});
