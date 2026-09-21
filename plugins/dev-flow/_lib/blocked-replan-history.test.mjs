// blocked-replan-history.test.mjs — BLOCKED 再実装（reimpl-blocked#b）の findings 累積と BLOCK_MAX を
// dev-flow.js 全体の VM 実行で pin する（issue #673 AC-4）。
//
// planner agent を起動せず、blockSeen 累積の approach_mismatch findings（過去に BLOCKED になった
// 全アプローチへの回帰禁止）を prompt に付けて dev-implement-fable を `reimpl-blocked#b` で再 spawn する:
//   case1: BLOCKED ×2 → 3 回目 DONE — reimpl-blocked#2 prompt に R1 と R2 の両方（累積）が載り、
//          BLOCK_MAX 到達 log は出ず、evaluator prompt に approach_mismatch concern は残らない
//   case2: BLOCKED ×3（BLOCK_MAX=2 到達）— human review へ委譲（BLOCK_MAX log）し、未解消 BLOCKED は
//          approach_mismatch concern として evaluator の focus_areas に渡る
//   case3: all DONE — reimpl-blocked は 0 回

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const FABLE = 'dev-flow:dev-implement-fable';
const GONE_AGENTS = ['dev-flow:dev-planner', 'dev-flow:plan-reviewer', 'dev-flow:implementer'];

// standard shape: count=4 (3-5), AC<=6, issue_type=fix, no breaking keywords
const STANDARD_REQ = {
  summary: 's', acceptance_criteria: ['a', 'b', 'c', 'd'], issue_type: 'fix', scope: 'src',
  estimated_change_file_count: 4, shape: 'standard', issue_number: 1, issue_title: 'stub-issue-title',
};

const blocked = (detail) => ({
  status: 'BLOCKED', task_id: 'issue-1', files: [], summary: '', concerns: [],
  blocking_reason: { block_class: 'approach_mismatch', detail },
});
const done = { status: 'DONE', task_id: 'issue-1', files: ['src/x.ts'], summary: 'ok', concerns: [] };

async function run(overrides) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { 'analyze#1': STANDARD_REQ, ...overrides } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'blocked-replan-history');
  return { calls, logs, result, error };
}

const reimplBlocked = (calls) => calls.filter((c) => c.label.startsWith('reimpl-blocked#'));
const evalPrompt = (calls) => calls.find((c) => c.agentType === 'dev-flow:evaluator')?.prompt ?? '';

test('[blocked-replan-history] case1: BLOCKED ×2 → 3 回目 DONE — reimpl-blocked#2 prompt に R1+R2 が累積し、BLOCK_MAX 到達せず完走', async () => {
  const { calls, logs, result, error } = await run({
    'impl:serial:issue-1': blocked('R1: patch-api approach failed'),
    'reimpl-blocked#1:serial:issue-1': blocked('R2: hook approach failed'),
    'reimpl-blocked#2:serial:issue-1': done,
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);

  const rb = reimplBlocked(calls);
  assert.deepEqual(rb.map((c) => c.label), ['reimpl-blocked#1:serial:issue-1', 'reimpl-blocked#2:serial:issue-1'], `reimpl-blocked は 2 回のはず: ${rb.map((c) => c.label).join(', ')}`);
  for (const c of rb) assert.equal(c.agentType, FABLE, `${c.label} の agentType が ${c.agentType}（dev-implement-fable のはず）`);
  assert.equal(calls.filter((c) => GONE_AGENTS.includes(c.agentType)).length, 0, 'planner 系 agent が起動した');
  assert.equal(calls.filter((c) => c.label.startsWith('replan-blocked#')).length, 0, 'dev-planner 向け replan-blocked#b が起動した');

  // (a) reimpl-blocked#1 prompt: R1 のみ + 回帰禁止の指示
  const p1 = rb[0].prompt;
  assert.ok(p1.includes('前回実装が BLOCKED になった'), 'reimpl-blocked#1 prompt に BLOCKED 再実装の指示が無い');
  assert.ok(p1.includes('R1: patch-api approach failed'), 'reimpl-blocked#1 prompt に R1 が無い');
  assert.ok(p1.includes('回帰も禁止'), 'reimpl-blocked#1 prompt にアプローチ回帰禁止の指示が無い');
  assert.equal((p1.match(/"dimension":"approach_mismatch"/g) ?? []).length, 1, 'reimpl-blocked#1 prompt の approach_mismatch findings は 1 件のはず');

  // (b) reimpl-blocked#2 prompt: R1 と R2 の両方（blockSeen 累積）
  const p2 = rb[1].prompt;
  assert.ok(p2.includes('R1: patch-api approach failed'), `reimpl-blocked#2 prompt に R1（累積分）が無い。prompt[:600]: ${p2.slice(0, 600)}`);
  assert.ok(p2.includes('R2: hook approach failed'), `reimpl-blocked#2 prompt に R2 が無い。prompt[:600]: ${p2.slice(0, 600)}`);
  assert.equal((p2.match(/"dimension":"approach_mismatch"/g) ?? []).length, 2, 'reimpl-blocked#2 prompt の approach_mismatch findings は累積 2 件のはず');

  // (c) 3 回目 DONE → BLOCK_MAX 到達 log 無し・evaluator に approach_mismatch concern 無し・PR まで完走
  assert.ok(!logs.some((m) => m.includes('回再実装しても')), `BLOCK_MAX 到達 log が出ている: ${logs.filter((m) => m.includes('BLOCKED')).join(' | ')}`);
  assert.ok(!evalPrompt(calls).includes('approach_mismatch(issue-1)'), 'DONE で解消したのに evaluator prompt に approach_mismatch concern が残っている');
  assert.ok(result?.pr_url != null, `完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)}`);
});

test('[blocked-replan-history] case2: BLOCKED ×3 → BLOCK_MAX=2 到達で human review へ委譲、未解消 BLOCKED が evaluator focus_areas に渡る', async () => {
  const { calls, logs, error } = await run({
    'impl:serial:issue-1': blocked('R1: patch-api approach failed'),
    'reimpl-blocked#1:serial:issue-1': blocked('R2: hook approach failed'),
    'reimpl-blocked#2:serial:issue-1': blocked('R3: rewrite approach failed'),
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);

  const rb = reimplBlocked(calls);
  assert.equal(rb.length, 2, `BLOCK_MAX=2 で reimpl-blocked は 2 回のはず: ${rb.map((c) => c.label).join(', ')}`);
  assert.ok(logs.some((m) => m.includes('2 回再実装しても')), `BLOCK_MAX 到達 log が無い: ${logs.join(' | ')}`);
  const ev = evalPrompt(calls);
  assert.ok(ev.length > 0, 'evaluator が起動していない');
  assert.ok(ev.includes('R3: rewrite approach failed'), `evaluator prompt に未解消 BLOCKED（R3）が focus_areas として渡っていない。prompt[:800]: ${ev.slice(0, 800)}`);
  assert.ok(ev.includes('approach_mismatch(issue-1)'), 'evaluator prompt に approach_mismatch concern の接頭辞が無い');
});

test('[blocked-replan-history] case3: all DONE → reimpl-blocked 0 回・BLOCKED log 無し', async () => {
  const { calls, logs, error } = await run({});
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(reimplBlocked(calls).length, 0, `all DONE で reimpl-blocked が起動した: ${reimplBlocked(calls).map((c) => c.label).join(', ')}`);
  assert.equal(logs.filter((m) => m.includes('BLOCKED')).length, 0, `all DONE で BLOCKED log が出た: ${logs.filter((m) => m.includes('BLOCKED')).join('; ')}`);
});
