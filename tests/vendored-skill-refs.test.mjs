import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SKILLS_LOCK_PATH = path.join(REPO_ROOT, 'plugins', 'playpark-skills', 'skills-lock.json');

const REMOVED_VENDORED_SKILLS = [
  'vercel-react-best-practices',
  'fastify-best-practices',
  'prisma-cli',
  'neon-postgres',
  'remotion-best-practices',
];

// (d) skills-lock.json の skills に除去対象 5 件のキーがいずれも存在しない
test('skills-lock.json の skills に除去対象の vendored 5 件が存在しない', () => {
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
