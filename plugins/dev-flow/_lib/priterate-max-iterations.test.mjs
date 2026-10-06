// F1: max_iterations の検証を pin する TDD テスト（red phase）
// テストケース:
//   (1) args={pr:'5', max_iterations:'abc'} → vm 実行が reject し error.message が /正の整数/ にマッチ
//   (2) args={pr:'5', max_iterations:'3'} で pr-reviewer が常に request-changes（topic 毎回ユニーク）→
//       result.status==='max_reached' かつ result.iterations===3
//   (3) args={pr:'5'}（max_iterations 未指定）で pr-reviewer が即 approve、ci-check passed → lgtm
//   (4) args='5'（bare string、max_iterations なし）でも lgtm（単体起動の回帰防止）
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / prIterateRounds / runWorkflowCapture
// （既定 responder は reviewer approve・ci-check passed）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, prIterateRounds, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

async function runPrIterate({ args, rounds = null }) {
  const { ctx } = makePrIterateSandbox({ args, rounds });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  return { result, error };
}

// ---- テストケース (1): max_iterations='abc' → 明示 throw ----
test('[max-iterations] max_iterations="abc" を渡すと /正の整数/ エラーで reject される（NaN silent 受理の禁止）', async () => {
  const { result, error } = await runPrIterate({ args: { pr: '5', max_iterations: 'abc' } });

  assert.ok(
    error != null,
    `max_iterations='abc' では error が throw されるべきだが、error は null で result=${JSON.stringify(result)} だった`,
  );
  assert.match(error?.message ?? '', /正の整数/, `error.message に '正の整数' が含まれるべきだが: "${error?.message}"`);
});

// ---- テストケース (2): max_iterations='3' で request-changes 3 回 → max_reached ----
test('[max-iterations] max_iterations="3" を渡すと上限 3 で max_reached になる', async () => {
  const { result, error } = await runPrIterate({
    args: { pr: '5', max_iterations: '3' },
    rounds: prIterateRounds({
      // topic を毎回ユニークにして REVIEW_STUCK=2 の stuck 検出を回避
      reviewer: (n) => ({
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: `t${n}`, description: `issue ${n}` }],
        summary: 'ng',
      }),
      fix: [{ applied: true, summary: 'fixed', files: [] }],
      // fix 適用直後の commit 保証（issue #437）は「commit 対象なし」で通す
      commitEnsure: { dirty: false, committed: false, pushed: false },
    }),
  });
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'max_reached', `result.status は 'max_reached' であるべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 3, `result.iterations は 3 であるべきだが ${result?.iterations} だった`);
});

// ---- テストケース (3)(4): max_iterations 未指定で approve → lgtm ----
test.each([
  ['args={pr:"5"}（max_iterations 未指定）で approve → lgtm（default 10 の正常系維持）', { pr: '5' }],
  ['args="5"（bare string、max_iterations なし）で approve → lgtm（単体起動の回帰防止）', '5'],
])('[max-iterations] %s', async (_name, args) => {
  const { result, error } = await runPrIterate({ args });
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});
