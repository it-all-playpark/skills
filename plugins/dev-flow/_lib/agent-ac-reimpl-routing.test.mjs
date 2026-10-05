// AC の actor（agent / human）で Evaluate の差し戻しと Merge tier の HOLD 理由を分ける経路を VM 実行で pin する（issue #747）。
//   (A) 「ローカルで測って PR 本文に書く」型の agent AC が satisfied:false → standard でも reimpl#1 が走り、
//       fix_feedback に AC-1 未達が載る。reimpl が返した pr_notes / design_decisions が PR 本文に載り、再評価で満たせば HOLD しない
//   (B) `（人手）` の AC だけが未達 → 差し戻さず HOLD（ac_human_pending = 人手 AC 待ち）
//   (C) agent AC が差し戻し上限後も未達 → HOLD（ac_agent_unsatisfied = 取りこぼし）。返り値で actor 別に数えられる

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';
import { AGENT_AC_REIMPL_MAX } from './ac-actor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const MEASURE_AC = '512Mi で、想定する同時生成数の worker を持てることをローカルで測り、PR 本文に書く';
const HUMAN_AC = 'staging で 1 回生成して所要時間を確認する（人手）';
const CODE_AC = 'worker 数の上限を設定で変えられる';

const STANDARD = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
const impl = (extra = {}) => ({ status: 'DONE', task_id: 'issue-1', files: [...STANDARD], summary: 's', concerns: [], ...extra });
const evalWith = (sat) => ({
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: sat.map((s, i) => ({ ac_index: i, satisfied: s, verified_by: 'inspection', evidence: s ? 'ok' : '計測値がコードのコメントにしかない' })),
  security_clearance: [], concern_resolutions: [],
});

async function run(acs, overrides) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides, extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: acs }) }) } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'agent-ac-reimpl');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, logs };
}

// VM context の配列・object は prototype が別 realm なので、deepStrictEqual の前に JSON で本 realm へ写す
const plain = (v) => JSON.parse(JSON.stringify(v));
const reimplCalls = (calls) => calls.filter((c) => /^reimpl#\d+:serial:issue-1$/.test(c.label));
const evalCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:evaluator' && c.label.startsWith('eval#'));

test('[agent-ac-reimpl] (A) 計測して PR 本文に書く AC が未達 → standard でも差し戻し、返した計測値・設計判断が PR 本文に載る', async () => {
  const { result, calls } = await run([MEASURE_AC, CODE_AC], {
    'impl:serial:issue-1': impl(),
    'eval#1': evalWith([false, true]),
    'reimpl#1:serial:issue-1': impl({
      design_decisions: [{ title: 'worker 上限は 4', rationale: '512Mi に収まる最大数' }],
      pr_notes: [{ section: 'measurement', text: '512Mi で worker 4 本: app 全体の RSS 合計 380Mi（ローカル計測）' }],
    }),
    'eval#2': evalWith([true, true]),
  });
  const reimpl = reimplCalls(calls);
  assert.equal(reimpl.length, 1, `差し戻しは reimpl#1 の 1 回のはず: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(reimpl[0].agentType, 'dev-flow:dev-implementer');
  assert.match(reimpl[0].prompt, /fix_feedback/);
  assert.match(reimpl[0].prompt, /AC-1 未達/);
  assert.equal(evalCalls(calls).length, 2, 'standard でも差し戻し後に再評価する');
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall, 'PR phase が走る');
  assert.ok(prCall.prompt.includes('- 計測: 512Mi で worker 4 本: app 全体の RSS 合計 380Mi（ローカル計測）'), `PR 本文の検証に計測値: ${prCall.prompt}`);
  assert.ok(prCall.prompt.includes('- worker 上限は 4 — 512Mi に収まる最大数'), `PR 本文の設計判断: ${prCall.prompt}`);
  assert.equal(result?.merge_tier, 'REVIEW', `AC を満たしたので HOLD しない: ${JSON.stringify(result?.merge_tier_reasons)}`);
});

test('[agent-ac-reimpl] (A-final) fixes_applied>0 の Final AC reconcile にも pr_notes / 設計判断が渡り、PR 本文に書く AC が反転しない', async () => {
  const MEASURE_NOTE = '512Mi で worker 4 本: app 全体の RSS 合計 380Mi（ローカル計測）';
  const DECISION = 'worker 上限は 4';
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
    overrides: {
      'eval#1': evalWith([false, true]),
      'reimpl#1:serial:issue-1': impl({
        design_decisions: [{ title: DECISION, rationale: '512Mi に収まる最大数' }],
        pr_notes: [{ section: 'measurement', text: MEASURE_NOTE }],
      }),
      'eval#2': evalWith([true, true]),
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'test#final': { tests: 'passed', green: true, summary: '' },
      // evaluator の判定を模す: prompt に計測値（pr_notes）と設計判断が無ければ PR 本文に書く AC は未達
      'final-ac-reconcile': (c) => {
        const seen = c.prompt.includes(MEASURE_NOTE) && c.prompt.includes(DECISION);
        return { ac_results: [
          { ac_index: 0, satisfied: seen, verified_by: 'inspection', evidence: seen ? 'pr_notes に計測値' : '計測値が見当たらない' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ] };
      },
    },
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: [MEASURE_AC, CODE_AC] }) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'agent-ac-reimpl A-final');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const fac = calls.filter((c) => c.label === 'final-ac-reconcile');
  assert.equal(fac.length, 1, `fixes_applied>0 で final-ac-reconcile が 1 回走る: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(fac[0].prompt.includes(MEASURE_NOTE), `final-ac-reconcile prompt に pr_notes: ${fac[0].prompt}`);
  assert.ok(fac[0].prompt.includes(DECISION), `final-ac-reconcile prompt に architecture_decisions: ${fac[0].prompt}`);
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(result?.merge_tier, 'REVIEW', `reverified で AC を満たすので HOLD しない: ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [] });
});

test('[agent-ac-reimpl] (A-ctrl) 全 AC 満たせば standard は evaluator 1 回・差し戻しなし', async () => {
  const { calls } = await run([MEASURE_AC, CODE_AC], { 'eval#1': evalWith([true, true]) });
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(evalCalls(calls).length, 1);
});

test('[agent-ac-reimpl] (B) （人手）の AC だけが未達 → 差し戻さず HOLD（人手 AC 待ち）', async () => {
  const { result, calls } = await run([CODE_AC, HUMAN_AC], { 'eval#1': evalWith([true, false]) });
  assert.equal(reimplCalls(calls).length, 0, `人手 AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(evalCalls(calls).length, 1);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [1] });
});

test('[agent-ac-reimpl] (C) agent AC が差し戻し上限後も未達 → HOLD 理由は取りこぼし（ac_agent_unsatisfied）で人手待ちと区別できる', async () => {
  const { result, calls } = await run([MEASURE_AC, HUMAN_AC], {
    'eval#1': evalWith([false, false]),
    'eval#2': evalWith([false, false]),
    'eval#3': evalWith([false, false]),
  });
  assert.equal(reimplCalls(calls).length, AGENT_AC_REIMPL_MAX, `差し戻しは上限 ${AGENT_AC_REIMPL_MAX} 回: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(evalCalls(calls).length, AGENT_AC_REIMPL_MAX + 1);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_agent_unsatisfied', 'ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [0], human: [1] });
});
