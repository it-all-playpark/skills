// shape 別の Evaluate 深さを VM 実行の呼び出しカウントで pin する（string-pattern ではなく挙動）。
// Plan phase は全 shape で合成 plan のみ（issue #673）— plan review ループは存在しない。
//   (A) standard: evaluator ちょうど 1 回（EVAL_PASSES=1）。evaluator が fail を返しても差し戻さない
//   (B) complex: evaluator が fail → reimpl#1（dev-implement-fable）→ 2 回目 pass で収束（差し戻し loop）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const AC4 = ['a', 'b', 'c', 'd'];
const ACR = AC4.map((_, i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' }));
const EVAL_FAIL = {
  verdict: 'fail', total: 5, threshold: 7,
  feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
  feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
};
const EVAL_PASS = {
  verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
  ac_results: ACR, security_clearance: [],
  critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
};

// standard に落ちる req（count=3 ≤ 5, ac.length=4 ≤ 6, type=feat → floor='standard'）
const STANDARD_REQ = { summary: 's', acceptance_criteria: AC4, issue_type: 'feat', scope: 'src', estimated_change_file_count: 3, shape: 'standard', issue_number: 1, issue_title: 'stub-issue-title' };
// complex に落ちる req（count=8 > 5 → floor='complex'）
const COMPLEX_REQ = { summary: 's', acceptance_criteria: AC4, issue_type: 'feat', scope: 'src', estimated_change_file_count: 8, shape: 'complex', issue_number: 1, issue_title: 'stub-issue-title' };

async function run(overrides) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'shape-loop');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return calls;
}

test('[shape-loop] SHAPE=standard: evaluator 呼び出し 1 回（fail でも差し戻さない）・plan review 系 agent 0 回', async () => {
  const calls = await run({ 'analyze#1': STANDARD_REQ, 'eval#1': EVAL_FAIL, 'eval#2': EVAL_PASS });
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(evaluatorCalls.length, 1, `SHAPE=standard: evaluator は 1 回呼ばれるべきだが ${evaluatorCalls.length} 回呼ばれた`);
  assert.equal(calls.filter((c) => c.label.startsWith('reimpl#')).length, 0, 'standard で Evaluate 差し戻し（reimpl#i）が発火した');
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:plan-reviewer' || c.agentType === 'dev-flow:dev-planner').length, 0, 'plan review 系 agent が起動した');
});

test('[shape-loop] SHAPE=complex: evaluator fail → reimpl#1（dev-implement-fable）→ pass で evaluator 2 回（制御群）', async () => {
  const calls = await run({ 'analyze#1': COMPLEX_REQ, 'eval#1': EVAL_FAIL, 'eval#2': EVAL_PASS });
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(evaluatorCalls.length, 2, `SHAPE=complex: evaluator は 2 回（fail → 差し戻し → pass）のはずだが ${evaluatorCalls.length} 回だった`);
  const reimpl = calls.filter((c) => c.label === 'reimpl#1:serial:issue-1');
  assert.equal(reimpl.length, 1, `complex の差し戻しは reimpl#1:serial:issue-1 の 1 回のはず: ${calls.filter((c) => c.label.startsWith('reimpl')).map((c) => c.label).join(', ')}`);
  assert.equal(reimpl[0].agentType, 'dev-flow:dev-implement-fable', `reimpl#1 の agentType が ${reimpl[0].agentType}`);
});
