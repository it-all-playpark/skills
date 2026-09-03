import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SKILLS_LOCK_PATH = path.join(REPO_ROOT, 'skills-lock.json');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');
const REMOTION_VIDEO_SKILL_PATH = path.join(
  REPO_ROOT,
  'plugins',
  'playpark-skills',
  'remotion-video',
  'SKILL.md',
);
const REMOTION_VIDEO_GUIDE_PATH = path.join(
  REPO_ROOT,
  'plugins',
  'playpark-skills',
  'remotion-video',
  'references',
  'implementation-guide.md',
);

const REMOVED_VENDORED_SKILLS = [
  'vercel-react-best-practices',
  'fastify-best-practices',
  'prisma-cli',
  'neon-postgres',
];

// (a) remotion-video/SKILL.md が remotion-best-practices を参照し続ける
test('remotion-video/SKILL.md が remotion-best-practices を参照している', () => {
  const content = readFileSync(REMOTION_VIDEO_SKILL_PATH, 'utf-8');
  assert.ok(
    content.includes('remotion-best-practices'),
    'remotion-video/SKILL.md に "remotion-best-practices" の参照がない',
  );
});

// (b) remotion-video/references/implementation-guide.md が remotion-best-practices を参照し続ける
test('remotion-video/references/implementation-guide.md が remotion-best-practices を参照している', () => {
  const content = readFileSync(REMOTION_VIDEO_GUIDE_PATH, 'utf-8');
  assert.ok(
    content.includes('remotion-best-practices'),
    'remotion-video/references/implementation-guide.md に "remotion-best-practices" の参照がない',
  );
});

// (c) skills-lock.json の skills に remotion-best-practices キーが存在する
test('skills-lock.json の skills に remotion-best-practices キーが存在する', () => {
  const lock = JSON.parse(readFileSync(SKILLS_LOCK_PATH, 'utf-8'));
  assert.ok(
    Object.prototype.hasOwnProperty.call(lock.skills, 'remotion-best-practices'),
    'skills-lock.json の skills に "remotion-best-practices" キーが存在しない',
  );
});

// (d) skills-lock.json の skills に除去対象 4 件のキーがいずれも存在しない
test('skills-lock.json の skills に除去対象の vendored 4 件が存在しない', () => {
  const lock = JSON.parse(readFileSync(SKILLS_LOCK_PATH, 'utf-8'));
  const present = REMOVED_VENDORED_SKILLS.filter((name) =>
    Object.prototype.hasOwnProperty.call(lock.skills, name),
  );
  assert.deepEqual(
    present,
    [],
    `skills-lock.json の skills に除去対象のキーが残っている: ${present.join(', ')}`,
  );
});

// (e) .gitignore の external skills ブロックに remotion-best-practices 行が存在する
test('.gitignore の external skills ブロックに remotion-best-practices 行が存在する', () => {
  const content = readFileSync(GITIGNORE_PATH, 'utf-8');
  const blockMatch = content.match(
    /# --- external skills \(auto-managed\) ---\n([\s\S]*?)\n# --- end external skills ---/,
  );
  assert.ok(blockMatch, '.gitignore に external skills ブロックが見つからない');
  const blockLines = blockMatch[1].split('\n');
  assert.ok(
    blockLines.includes('plugins/playpark-skills/remotion-best-practices'),
    'external skills ブロックに "plugins/playpark-skills/remotion-best-practices" 行が存在しない',
  );
});
