// _lib/redgreen-runner-docs.test.mjs
// redgreen-verify.sh の受理 glob と evaluator.md の申告制限 / exec-proxy.md の redgreen 行の
// drift を検出する（issue #656）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const evaluatorMd = readFileSync(join(repoRoot, 'agents/evaluator.md'), 'utf8');
const execProxyMd = readFileSync(join(repoRoot, 'dev-flow/references/exec-proxy.md'), 'utf8');

test('evaluator.md: test_files 申告制限に 4 glob（*.test.mjs / *.bats / *.test.ts / *.test.tsx）が並ぶ', () => {
  const line = evaluatorMd
    .split('\n')
    .find((l) => /test_files は repo の test discovery/.test(l));
  assert.ok(line, 'test_files 申告制限の行が見つからない');
  assert.ok(line.includes('`*.test.mjs`'));
  assert.ok(line.includes('`*.bats`'));
  assert.ok(line.includes('`*.test.ts`'));
  assert.ok(line.includes('`*.test.tsx`'));
});

test('evaluator.md: test_files 申告制限が *.spec.ts を除外している', () => {
  const line = evaluatorMd
    .split('\n')
    .find((l) => /test_files は repo の test discovery/.test(l));
  assert.ok(line, 'test_files 申告制限の行が見つからない');
  assert.ok(line.includes('*.spec.ts'));
});

test('exec-proxy.md: redgreen 行に受理 glob 4 つが記載される', () => {
  const match = execProxyMd.match(/^\| redgreen.*$/m);
  assert.ok(match, 'redgreen 行が見つからない');
  const line = match[0];
  assert.ok(line.includes('*.test.mjs'));
  assert.ok(line.includes('*.bats'));
  assert.ok(line.includes('*.test.ts'));
  assert.ok(line.includes('*.test.tsx'));
});
