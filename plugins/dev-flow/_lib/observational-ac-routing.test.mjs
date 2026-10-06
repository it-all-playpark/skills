// 観測型 AC（実行して出力・記録を観測しないと確かめられない AC）の Evaluate / Final reconcile / Merge tier 経路を
// VM 実行で pin する（issue #844）。
//   (A) inspection の satisfied:true → checked にせず、差し戻さず、merge tier は ac_human_pending の HOLD。
//       終端サマリーの対応欄は「実行して AC の主張を確認する」で、どの AC が観測型かが分かる
//   (B) verified_by:test + redgreen で red→green 実証（deterministic 昇格）→ checked、HOLD しない
//   (C) verified_by:test でも red→green 不成立 → (A) と同じく人手 AC 待ち（差し戻さない）
//   (D) Final reconcile の inspection pass（final reconcile pass）でも観測型 AC を checked にしない
//   (E) Evaluate で red→green 実証済みの観測型 AC は Final reconcile 後も達成のまま

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const OBS_AC = '実 run の journal に `duration_seconds` が記録される';
const CODE_AC = 'worker 数の上限を設定で変えられる';
const OBS_ACTION = '実行して AC の主張を確認する（例: merge 後の実 run・計測）';

const inspection = (i, satisfied = true) => ({ ac_index: i, satisfied, verified_by: 'inspection', evidence: satisfied ? 'コードを読んで確認' : '未達' });
const byTest = (i) => ({ ac_index: i, satisfied: true, verified_by: 'test', evidence: 'test green', test_files: ['src/x.test.ts'], impl_files: ['src/x.ts'] });
const evalWith = (acResults) => ({
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: acResults, security_clearance: [], concern_resolutions: [],
});
const RG_PROVEN = { results: [{ index: 0, red: true, green: true }] };
const RG_NOT_RED = { results: [{ index: 0, red: false, green: true, reason: 'impl を外しても green' }] };

// VM context の配列・object は prototype が別 realm なので、deepStrictEqual の前に JSON で本 realm へ写す
const plain = (v) => JSON.parse(JSON.stringify(v));
const reimplCalls = (calls) => calls.filter((c) => /^reimpl#\d+:serial:issue-1$/.test(c.label));
const evalCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:evaluator' && c.label.startsWith('eval#'));

async function run(overrides, opts = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    overrides,
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: [OBS_AC, CODE_AC] }) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'observational-ac');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, logs };
}

const FIXED_ITERATE = async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 });
const FINAL_OK = { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) }, 'test#final': { tests: 'passed', green: true, summary: '' } };

test('[observational-ac] (A) inspection の satisfied:true → checked にせず差し戻さず、ac_human_pending の HOLD。サマリーの対応欄は実行による確認', async () => {
  const { result, calls } = await run({ 'eval#1': evalWith([inspection(0), inspection(1)]) });
  assert.equal(reimplCalls(calls).length, 0, `観測型 AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(evalCalls(calls).length, 1);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0] });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes(`- [ ] ${OBS_AC}`), `PR 本文で観測型 AC が checked になった: ${prCall.prompt}`);
  const summary = calls.find((c) => c.label === 'post-summary');
  assert.ok(summary, 'post-summary が走る');
  assert.ok(summary.prompt.includes(OBS_ACTION), `対応欄が実行による確認になっていない: ${summary.prompt}`);
  assert.ok(summary.prompt.includes('観測型 AC（AC#1）'), `どの AC が観測型か分からない: ${summary.prompt}`);
  assert.ok(summary.prompt.includes('| ❌ 未達 | AC#1（観測型） |'), `未達表に観測型の印が無い: ${summary.prompt}`);
});

test('[observational-ac] (B) verified_by:test + redgreen で red→green 実証 → deterministic 昇格で checked、HOLD しない', async () => {
  const { result, calls } = await run({ 'eval#1': evalWith([byTest(0), inspection(1)]), redgreen: RG_PROVEN });
  assert.equal(calls.filter((c) => c.label === 'redgreen').length, 1);
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result?.merge_tier, 'REVIEW', `red→green 実証済みなので HOLD しない: ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [] });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes(`- [x] ${OBS_AC}`), `PR 本文で観測型 AC が checked にならない: ${prCall.prompt}`);
});

test('[observational-ac] (C) verified_by:test でも red→green 不成立 → checked にせず差し戻さず ac_human_pending の HOLD', async () => {
  const { result, calls } = await run({ 'eval#1': evalWith([byTest(0), inspection(1)]), redgreen: RG_NOT_RED });
  assert.equal(reimplCalls(calls).length, 0, `観測型 AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0] });
});

test('[observational-ac] (D) Final reconcile の inspection pass でも観測型 AC を checked にせず、ac_human_pending の HOLD のまま', async () => {
  const { result, calls } = await run({
    'eval#1': evalWith([inspection(0, false), inspection(1)]),
    ...FINAL_OK,
    'final-ac-reconcile': { ac_results: [inspection(0), inspection(1)] },
  }, { workflow: FIXED_ITERATE });
  assert.equal(calls.filter((c) => c.label === 'final-ac-reconcile').length, 1, `final-ac-reconcile が走らない: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0] });
});

test('[observational-ac] (E) Evaluate で red→green 実証済みの観測型 AC は Final reconcile 後も達成のまま', async () => {
  const { result } = await run({
    'eval#1': evalWith([byTest(0), inspection(1)]),
    redgreen: RG_PROVEN,
    ...FINAL_OK,
    'final-ac-reconcile': { ac_results: [inspection(0), inspection(1)] },
  }, { workflow: FIXED_ITERATE });
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(result?.merge_tier, 'REVIEW', `red→green 実証済みなので HOLD しない: ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [] });
});
