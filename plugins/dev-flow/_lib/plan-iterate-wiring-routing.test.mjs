// plan-iterate-wiring-routing: dev-flow.js の「配線」を VM 挙動として検証する（issue #636）。
//
// 旧来は dev-flow.js のソース文字列（`iterateStatus: iterate?.status ?? null,` 等の行、
// `const PLAN_RELAX_FROM = 2`、classifyMergeTier 呼び出しブロック内の planConcerns 不在）を
// src.includes / regex で pin していた。ここでは dev-flow.js を VM で実際に実行し、
// 配線が切れたときに変わる観測値（返り値・agent() 呼び出し回数・journal telemetry・
// post-summary の構造 marker）だけを assert する。
//
// テストケース:
//   (a) pr-iterate が fix_failed で終端 → merge_tier=HOLD / eval_staleness=iterate_incomplete /
//       journal telemetry に iterate_status・iterate_rounds / post-summary に HOLD marker と
//       history 末尾 round の file パス（iterateHistory・iterateIterations 配線）
//   (b) plan-reviewer が毎回 revise（critical 無し）→ PLAN_RELAX_FROM=2 で収束し review は 2 回、
//       未解消 finding は CONCERN-* として evaluator prompt に渡り、merge_tier は
//       plan concerns 無しの既定経路と同じ（merge tier は planConcerns を入力に持たない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, withImplementMode } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// IMPLEMENT_MODE を 'planner' に固定（従来経路 dev-planner ⇄ plan-reviewer → implementer を pin する。
// 全 shape の 'fable' 経路は devflow-implement-fable-routing.test.mjs が検証する。issue #670）
const devFlowSrc = withImplementMode(readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8'), 'planner');

// ============================================================
// (a) pr-iterate 非 LGTM 終端の配線
// ============================================================

test('[wiring] (a) pr-iterate fix_failed → HOLD / iterate_incomplete / telemetry と summary に iterate 情報が配線される', async () => {
  const history = [{
    iteration: 3,
    decision: 'request_changes',
    summary: 's',
    blocking: [{ severity: 'major', topic: 't', file: 'src/wired-by-history.ts', line: 7, description: 'd', suggestion: null }],
    minor: [],
  }];
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async () => ({ status: 'fix_failed', iterations: 3, fixes_applied: 1, history }),
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.equal(result.iterate_status, 'fix_failed');
  assert.equal(result.eval_staleness, 'iterate_incomplete', `(a) eval_staleness: ${JSON.stringify(result.eval_staleness)}`);
  assert.equal(result.merge_tier, 'HOLD', `(a) merge_tier: ${JSON.stringify(result.merge_tier)}`);
  assert.ok(
    (result.merge_tier_reasons ?? []).some((r) => r.includes('fix_failed')),
    `(a) merge_tier_reasons に iterate status を含む理由が無い: ${JSON.stringify(result.merge_tier_reasons)}`,
  );

  const journal = calls.find((c) => c.label === 'journal-save');
  assert.ok(journal, '(a) journal-save が呼ばれていない');
  assert.ok(journal.prompt.includes('"iterate_status":"fix_failed"'), `(a) telemetry に iterate_status が無い:\n${journal.prompt.slice(0, 600)}`);
  assert.ok(journal.prompt.includes('"iterate_rounds":3'), `(a) telemetry に iterate_rounds=3 が無い:\n${journal.prompt.slice(0, 600)}`);
  assert.ok(journal.prompt.includes('"eval_staleness":"iterate_incomplete"'), `(a) telemetry に eval_staleness が無い:\n${journal.prompt.slice(0, 600)}`);

  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, '(a) post-summary が呼ばれていない');
  assert.ok(post.prompt.includes('<!-- dev-flow:HOLD -->'), '(a) post-summary に HOLD marker が無い');
  assert.ok(
    post.prompt.includes('src/wired-by-history.ts'),
    '(a) post-summary に iterateHistory 末尾 round の file パスが無い（iterateHistory / iterateIterations の配線切れ）',
  );
});

// ============================================================
// (b) plan relax 収束と planConcerns の配線
// ============================================================

// plan-reviewer ループは complex 経路のみ起動する（standard は plan 1 発）
const COMPLEX_ANALYZE = {
  summary: 's', acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], issue_type: 'feat', scope: 'src',
  estimated_change_file_count: 12, shape: 'complex', issue_number: 1, issue_title: 'stub-issue-title',
};

test('[wiring] (b) plan-reviewer 毎回 revise → 2 回で収束、finding は CONCERN-* として evaluator へ、merge_tier は既定と同じ', async () => {
  const baseline = makeDevFlowSandbox({ overrides: { 'analyze#1': COMPLEX_ANALYZE } });
  const base = await runWorkflowCapture(devFlowSrc, baseline.ctx);
  assertNoCrash(base.error, 'b-baseline');
  assert.ok(base.result !== null, '(b) baseline は return object を返すべきだが null だった');
  assert.equal(base.result.plan_verdict, 'pass');

  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'analyze#1': COMPLEX_ANALYZE,
      'review#1': { score: 60, verdict: 'revise', findings: [{ severity: 'major', topic: 'topic-x', description: 'desc-x' }], summary: 'ng' },
      'review#2': { score: 60, verdict: 'revise', findings: [{ severity: 'major', topic: 'topic-x', description: 'desc-x' }], summary: 'ng' },
      'review#3': () => { throw new Error('review#3 must not run: PLAN_RELAX_FROM=2 で収束するはず'); },
    },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  const reviews = calls.filter((c) => c.agentType === 'dev-flow:plan-reviewer');
  assert.equal(reviews.length, 2, `(b) plan-reviewer は 2 回（PLAN_RELAX_FROM=2）のはずだが ${reviews.length} 回`);
  assert.equal(result.plan_verdict, 'revise');

  const eval1 = calls.find((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(eval1, '(b) evaluator が呼ばれていない');
  assert.ok(eval1.prompt.includes('CONCERN-1'), '(b) 未解消 plan finding が CONCERN-1 として evaluator prompt に渡っていない');
  assert.ok(eval1.prompt.includes('topic-x'), '(b) CONCERN-1 の text に plan finding の topic が無い');

  assert.equal(result.merge_tier, base.result.merge_tier, `(b) merge_tier は planConcerns の有無で不変のはず: ${result.merge_tier} vs ${base.result.merge_tier}`);
  assert.equal(JSON.stringify(result.merge_tier_reasons), JSON.stringify(base.result.merge_tier_reasons));
});
