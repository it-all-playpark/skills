// sandbox 内で実行できない AC（E2E 等）を人間に回さず、CI の check の結果で判定する経路を VM 実行で pin する（issue #861）。
//   (L) ci の AC（repo の ci_verify の commands / label に当たる AC）がある run だけ PR に label を付け、pr-iterate に
//       ci_verify（checks / 待機上限）を渡す。ci の AC が無い run・ci_verify が無い repo では付けない・渡さない
//   (R) ci の AC は evaluator / final-ac-reconcile の判定を使わず、reimpl・Evaluate の差し戻しに回さない。
//       pr-iterate の LGTM 後の待ちが success なら satisfied（HOLD しない）、未完了なら ac_ci_pending で HOLD
//   (U) ci_verify が無い repo で evaluator が unreachable_env:true を返した agent の AC は差し戻さず ac_human_pending にし、
//       終端サマリーの HOLD 理由欄と結論行に「修正が必要」を出さない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');
const evaluatorMd = readFileSync(join(here, '..', 'agents/evaluator.md'), 'utf8');

const CI_VERIFY = { label: 'full-ci', checks: ['e2e'], commands: ['pnpm test:e2e:local', 'pnpm test:e2e'], wait_ceiling_seconds: 1500 };
// acme/webapp#105 の AC#4
const E2E_AC = '`pnpm test:e2e:local`（または full-ci ラベルの CI）で `tenant-isolation.spec.ts` が通ることを確認する';
const CODE_AC = 'tenant ID を持たない query を repository 層で拒否する';
const E2E_LINK = 'https://github.com/acme/webapp/actions/runs/77/job/88';

const evalWith = (results, feedback = []) => ({
  verdict: 'pass', total: 100, threshold: 80, feedback, feedback_level: 'implementation',
  ac_results: results.map((r, i) => ({ ac_index: i, verified_by: 'inspection', evidence: r.satisfied ? 'ok' : 'e2e を実行できない', ...r })),
  security_clearance: [], concern_resolutions: [],
});

// VM context の値は別 realm なので deepStrictEqual の前に JSON で写す
const plain = (v) => JSON.parse(JSON.stringify(v));

async function run({ acs, ciVerify = null, overrides = {}, iterate = {} }) {
  const iterateArgs = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async (_name, a) => { iterateArgs.push(plain(a)); return { status: 'lgtm', iterations: 1, fixes_applied: 0, ...iterate }; },
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: acs }), ...(ciVerify ? { ci_verify: ciVerify } : {}) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'ci-verify-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const summary = calls.find((c) => c.label === 'post-summary')?.prompt ?? '';
  return { result, calls, iterateArgs, summary };
}

const reimplCalls = (calls) => calls.filter((c) => /^reimpl#\d+:serial:issue-1$/.test(c.label));
const evalCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:evaluator' && c.label.startsWith('eval#'));
const holdSection = (summary) => {
  const at = summary.indexOf('### HOLD になった理由と現状');
  return at < 0 ? '' : summary.slice(at, summary.indexOf('\n### ', at + 1));
};
const conclusion = (summary) => (summary.match(/\*\*結論: [^\n]*\*\*/) ?? [''])[0];

test('[ci-verify-routing] (L) ci の AC がある run は PR に label を付け、pr-iterate に ci_verify を渡す', async () => {
  const { calls, iterateArgs } = await run({
    acs: [CODE_AC, E2E_AC], ciVerify: CI_VERIFY,
    iterate: { ci_verify: { status: 'passed', checks: ['e2e'], urls: [E2E_LINK] } },
  });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes('--label "full-ci"'), `gh pr create に label を付ける: ${prCall.prompt}`);
  assert.equal(iterateArgs.length, 1);
  assert.deepEqual(iterateArgs[0].ci_verify, { label: 'full-ci', checks: ['e2e'], wait_ceiling_seconds: 1500 });
});

test('[ci-verify-routing] (L) ci の AC が無い run（ci_verify あり / 無し）は label を付けず ci_verify も渡さない', async () => {
  for (const ciVerify of [CI_VERIFY, null]) {
    const acs = ciVerify ? [CODE_AC, 'vitest で tenant 分離のテストを追加する'] : [CODE_AC, E2E_AC];
    const { calls, iterateArgs } = await run({ acs, ciVerify });
    const prCall = calls.find((c) => c.label === 'pr#1');
    assert.ok(!prCall.prompt.includes('--label'), `ci の AC が無いのに label を付けた（ci_verify=${JSON.stringify(ciVerify)}）`);
    assert.equal('ci_verify' in iterateArgs[0], false);
  }
});

test('[ci-verify-routing] (R) ci の AC は evaluator が未達・critical を返しても差し戻さず、CI の success で satisfied（HOLD しない）', async () => {
  const { result, calls } = await run({
    acs: [CODE_AC, E2E_AC], ciVerify: CI_VERIFY,
    overrides: {
      'eval#1': evalWith([{ satisfied: true }, { satisfied: false }], [
        { severity: 'critical', topic: 'e2e-not-run', description: 'E2E を実行できていない', suggestion: '実行する', ac_index: 1 },
      ]),
    },
    iterate: { ci_verify: { status: 'passed', checks: ['e2e'], urls: [E2E_LINK] } },
  });
  assert.equal(reimplCalls(calls).length, 0, `ci の AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(evalCalls(calls).length, 1);
  assert.equal(result.merge_tier, 'REVIEW', `CI success の ci の AC で HOLD した: ${JSON.stringify(result.merge_tier_hold_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [], ci: [] });
  assert.equal(result.ci_verify.status, 'passed');
});

test('[ci-verify-routing] (R) CI が待機上限まで未完了 → ac_ci_pending で HOLD し、サマリーは「CI の `e2e` 実行中 — 結果を確認して merge」', async () => {
  const { result, calls, summary } = await run({
    acs: [CODE_AC, E2E_AC], ciVerify: CI_VERIFY,
    overrides: { 'eval#1': evalWith([{ satisfied: true }, { satisfied: false }]) },
    iterate: { ci_verify: { status: 'pending', checks: ['e2e'], urls: [], waited_seconds: 1440 } },
  });
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_ci_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [], ci: [1] });
  assert.ok(holdSection(summary).includes('CI の `e2e` 実行中 — 結果を確認して merge'), holdSection(summary));
  assert.ok(!holdSection(summary).includes('修正が必要'), holdSection(summary));
  assert.ok(!conclusion(summary).includes('修正作業が必要'), conclusion(summary));
});

test('[ci-verify-routing] (R) fix 後の Final AC reconcile が ci の AC を未達と返しても AC-FINAL critical を積まない（CI の結果で決める）', async () => {
  const { result } = await run({
    acs: [CODE_AC, E2E_AC], ciVerify: CI_VERIFY,
    overrides: {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'test#final': { tests: 'passed', green: true, summary: '' },
      'final-ac-reconcile': { ac_results: [
        { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        { ac_index: 1, satisfied: false, verified_by: 'inspection', evidence: 'e2e を実行できない' },
      ] },
    },
    iterate: { iterations: 2, fixes_applied: 1, ci_verify: { status: 'passed', checks: ['e2e'], urls: [E2E_LINK] } },
  });
  assert.equal(result.final_ac_reconcile, 'reverified');
  assert.equal(result.merge_tier, 'REVIEW', JSON.stringify(result.merge_tier_hold_reasons));
});

test('[ci-verify-routing] (U) ci_verify が無い repo で unreachable_env:true の agent の AC → 差し戻さず ac_human_pending、「修正が必要」を出さない', async () => {
  const { result, calls, summary } = await run({
    acs: [CODE_AC, E2E_AC],
    overrides: { 'eval#1': evalWith([{ satisfied: true }, { satisfied: false, unreachable_env: true }]) },
  });
  assert.equal(reimplCalls(calls).length, 0, `実行環境に届かない AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  // evaluator の出力 schema が ac_results[].unreachable_env を受け、prompt と evaluator.md が付け方を指示している
  const ev = evalCalls(calls)[0];
  assert.deepEqual(plain(ev.schema.properties.ac_results.items.properties.unreachable_env), { type: 'boolean' });
  assert.ok(ev.prompt.includes('unreachable_env:true'), ev.prompt);
  assert.match(evaluatorMd, /`unreachable_env`/);
  assert.equal(result.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [1], ci: [] });
  const hold = holdSection(summary);
  assert.ok(hold.includes('実行して確認する'), hold);
  assert.ok(!hold.includes('修正が必要'), hold);
  assert.ok(conclusion(summary) !== '' && !conclusion(summary).includes('修正作業が必要'), conclusion(summary));
});

test('[ci-verify-routing] (U-ctrl) unreachable_env の無い agent の AC の未達は従来どおり差し戻す', async () => {
  const { calls } = await run({
    acs: [CODE_AC, E2E_AC],
    overrides: {
      'eval#1': evalWith([{ satisfied: true }, { satisfied: false }]),
      'eval#2': evalWith([{ satisfied: true }, { satisfied: true }]),
    },
  });
  assert.equal(reimplCalls(calls).length, 1);
});
