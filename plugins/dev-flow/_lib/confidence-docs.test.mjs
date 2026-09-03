// _lib/confidence-docs.test.mjs
// evaluator.md / pr-reviewer.md / dev-flow.md の confidence 記載を静的 pin する（issue #561, #154 スコープ3）。
// docs drift（判定基準の必須マーカー欠落・telemetry キー未記載）を検出する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const evaluatorMd = readFileSync(join(repoRoot, '.claude/agents/evaluator.md'), 'utf8');
const prReviewerMd = readFileSync(join(repoRoot, '.claude/agents/pr-reviewer.md'), 'utf8');
const devFlowRules = readFileSync(join(REPO_ROOT, '.claude/rules/dev-flow.md'), 'utf8');

test('evaluator.md: confidence が出現し判定基準の必須マーカーを含む', () => {
  assert.match(evaluatorMd, /confidence/);
  assert.match(evaluatorMd, /独立/);
  assert.match(evaluatorMd, /乱発/);
  assert.match(evaluatorMd, /記録専用/);
});

test('pr-reviewer.md: confidence が出現し判定基準の必須マーカーを含む', () => {
  assert.match(prReviewerMd, /confidence/);
  assert.match(prReviewerMd, /独立/);
  assert.match(prReviewerMd, /乱発/);
  assert.match(prReviewerMd, /記録専用/);
});

test('dev-flow.md: eval_confidence / review_confidence の両トークンが telemetry キー一覧に含まれる（AC-4 docs drift 防止）', () => {
  assert.match(devFlowRules, /eval_confidence/);
  assert.match(devFlowRules, /review_confidence/);
});
