// design-replan-cap.test.mjs — DESIGN_REPLAN_MAX cap テスト（issue #673 AC-5: fable 経路で書き直し）
// complex 経路で evaluator が毎回異なる topic の design critical を返し続けるとき
// (evalSeen の stuck 検出が発火しない = paraphrase 模倣)、DESIGN_REPLAN_MAX=2 で差し戻しが打ち切られ
// evaluator 呼び出しが 3 回で停止することを検証する。差し戻し先は dev-implement-fable（reimpl#i）で、
// planner agent は起動しない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, shapeOverrides } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

// complex に落とす: realized 7 件（shapeOverrides('complex')）→ EVAL_PASSES=EVAL_MAX=10 のループ経路
const COMPLEX_REQ = {
  summary: 's', acceptance_criteria: ['a', 'b', 'c', 'd'], issue_type: 'feat', scope: 'src',
  issue_number: 1, issue_title: 'stub-issue-title',
};
const COMPLEX_OVERRIDES = { 'analyze#1': COMPLEX_REQ, ...shapeOverrides('complex') };

// 毎回異なる topic を生成（paraphrase 模倣 = evalSeen の stuck 検出が発火しない）
function designCritical(callIndex) {
  return {
    verdict: 'fail', total: 5, threshold: 7,
    feedback: [{ severity: 'critical', topic: `design-flaw-paraphrase-${callIndex}`, description: `設計欠陥の言い換え${callIndex}`, suggestion: '再設計せよ' }],
    feedback_level: 'design',
    ac_results: COMPLEX_REQ.acceptance_criteria.map((_, i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
    security_clearance: [],
  };
}

test('[design-replan-cap] paraphrase design critical 連発 → DESIGN_REPLAN_MAX=2 で cap（reimpl#i は dev-implement-fable、planner 0 回）', async () => {
  const evalCalls = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      ...COMPLEX_OVERRIDES,
      // evaluator は label 'eval#i'。呼び出し順に異なる topic の design critical を返す
      ...Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`eval#${i}`, () => { evalCalls.push(i); return designCritical(i); }])),
    },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'design-replan-cap');
  assert.equal(error, null, `run が throw した: ${error?.message}`);

  // reimpl#i（Evaluate 差し戻し）は DESIGN_REPLAN_MAX=2 回で停止し、それ以上呼ばれない
  const reimplCalls = calls.filter((c) => /^reimpl#\d+:serial:issue-1$/.test(c.label));
  assert.deepEqual(reimplCalls.map((c) => c.label), ['reimpl#1:serial:issue-1', 'reimpl#2:serial:issue-1'],
    `差し戻しは DESIGN_REPLAN_MAX=2 回で停止すべきだが: ${reimplCalls.map((c) => c.label).join(', ')}`);
  for (const c of reimplCalls) assert.equal(c.agentType, 'dev-flow:dev-implement-fable', `${c.label} の agentType が ${c.agentType}`);
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-planner' || /^replan#\d+$/.test(c.label)).length, 0, 'design 差し戻しで dev-planner の replan が起動した');

  // eval#1→reimpl#1→eval#2→reimpl#2→eval#3 で cap break（DESIGN_REPLAN_MAX + 1 回）。EVAL_MAX=10 まで回らない
  assert.equal(evalCalls.length, 3, `evaluator は DESIGN_REPLAN_MAX+1=3 回で停止すべきだが ${evalCalls.length} 回呼ばれた`);

  // 未解消 critical が ledger に残り未収束のため HOLD
  assert.equal(result?.merge_tier, 'HOLD', `未解消 critical で収束しないため merge_tier は 'HOLD' であるべきだが '${result?.merge_tier}' だった`);
  assert.equal(result?.design_replan_count, 2, `design_replan_count は 2 であるべきだが ${result?.design_replan_count} だった`);
  assert.ok(logs.some((m) => m.includes('design replan 上限到達 — human review へ委譲')),
    `ログに 'design replan 上限到達 — human review へ委譲' が含まれるべきだが見つからなかった。ログ全文:\n${logs.join('\n')}`);
});
