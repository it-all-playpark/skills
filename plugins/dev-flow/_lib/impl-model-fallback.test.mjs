// dev-implement-fable の model fallback（issue #693）を dev-flow.js 全体の VM 実行で pin する。
//
// harness の agent() は fable の usage 上限 / terminal API error / user skip のいずれでも throw せず null を
// 返し、原因は script から読めない（null が唯一の観測点）。runImplement の call site は `fallbackModel: 'opus'`
// を opt-in し、trackedAgent が null を受けたら同一 prompt・同一 label に model: 'opus' を付けて 1 回だけ
// 再試行、以後その run の fallbackModel 付き call は最初から opus（run 単位 sticky）。
// green-fix は model: 'sonnet' を明示 override し fallback を持たない（sonnet は fable 上限と無関係）。
//
//   (a) impl:serial:issue-1 の 1 回目 null → 同 label で 2 回目が model:'opus'、implDroppedCount 0
//   (b) sticky: (a) 後の reimpl#1:serial:issue-1 は 1 回だけ、最初から model:'opus'
//   (c) 2 回とも null → drop 1、3 回目は呼ばれない
//   (d) green-fix#1 は model:'sonnet'、null でも 1 回のみ
//   (e) fallbackModel を持たない call（evaluator）の null は 1 回のみ（need() で abort）
//   (f) telemetry: impl_model_config:'fable' は成功 / failure / abort の 3 経路。impl_model_fallback_label は
//       発火 run のみ（未発火はキー無し）
//   (g) fallbackModel は agent() の opts に渡らない（harness 未知キーを流さない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs, COMPLEX_FILES } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const FABLE = 'dev-flow:dev-implement-fable';
const IMPL_OK = (files = ['src/x.ts', 'src/y.ts', 'src/z.ts']) => ({ status: 'DONE', task_id: 'issue-1', files: [...files], summary: 's', concerns: [] });

// n 回目まで null、以後 ok を返す responder（同一 label の再試行を数える）
function nullThenOk(nulls, ok) {
  let i = 0;
  return () => (i++ < nulls ? null : ok);
}

function parseJournalHandoffPayload(prompt) {
  const match = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(match, `journal-save prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない。prompt:\n${prompt.slice(0, 600)}`);
  return JSON.parse(match[1]);
}

async function runFlow(overrides = {}, extra = {}) {
  const journalPrompts = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'journal-save': ({ prompt }) => { journalPrompts.push(prompt); return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' }; },
      ...overrides,
    },
    extra,
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'impl-model-fallback');
  const payloads = journalPrompts.map(parseJournalHandoffPayload);
  return { calls, logs, error, payloads };
}

const byLabel = (calls, label) => calls.filter((c) => c.label === label);

test('[impl-fallback] (a) impl:serial:issue-1 が null → 同一 label・model:opus で 1 回再試行され、drop に計上されない', async () => {
  const { calls, logs, error } = await runFlow({ 'impl:serial:issue-1': nullThenOk(1, IMPL_OK()) });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const impl = byLabel(calls, 'impl:serial:issue-1');
  assert.equal(impl.length, 2, `impl:serial:issue-1 は fable 1 回 + opus 1 回の 2 回のはず: ${impl.length}`);
  assert.equal(impl[0].agentType, FABLE);
  assert.equal(impl[0].model, null, '1 回目は frontmatter 既定（model override なし）で spawn するはず');
  assert.equal(impl[1].agentType, FABLE, '再試行も同じ agent 定義（dev-implement-fable）のはず');
  assert.equal(impl[1].model, 'opus', '再試行は model:opus のはず');
  assert.equal(impl[1].prompt, impl[0].prompt, '再試行は同一 prompt のはず');
  assert.ok(logs.some((l) => l.includes('impl:serial:issue-1') && l.includes('opus') && l.includes('skip')), `fallback の log が無い: ${logs.filter((l) => l.includes('opus')).join(' | ')}`);
  assert.ok(!logs.some((l) => l.includes('dev-implement-fable 1 件が失敗(null)')), 'fallback 成功なのに drop の log が出ている');
  assert.ok(!logs.some((l) => l.includes('implement drop')), 'fallback 成功なのに implDroppedCount が計上されている');
});

test('[impl-fallback] (b) sticky: 発火後の reimpl#1 は fable 試行なしで最初から model:opus', async () => {
  const EVAL_FAIL = { verdict: 'fail', total: 50, threshold: 80, feedback: [{ topic: 'arch-split', severity: 'critical', dimension: 'implementation', description: 'split', suggestion: 'x' }], feedback_level: 'implementation', ac_results: [], security_clearance: [], concern_resolutions: [] };
  const EVAL_PASS = { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [], concern_resolutions: [], critical_resolutions: [{ id: 'EVAL-1-arch-split', resolved: true, evidence: 'ok' }] };
  const { calls, error } = await runFlow({
    'impl:serial:issue-1': nullThenOk(1, IMPL_OK(COMPLEX_FILES)),
    'reimpl#1:serial:issue-1': IMPL_OK(COMPLEX_FILES),
    'danger-grep': { risk: { ok: true, hits: [] }, files: [...COMPLEX_FILES], struct: null, diffhash: { hash: 'AAA', empty: false } },
    'eval#1': EVAL_FAIL,
    'eval#2': EVAL_PASS,
  }, { args: analyzeArgs(1, { acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], issue_type: 'feat' }) });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(byLabel(calls, 'impl:serial:issue-1').length, 2, 'impl は fable + opus の 2 回のはず');
  const reimpl = byLabel(calls, 'reimpl#1:serial:issue-1');
  assert.equal(reimpl.length, 1, `reimpl#1 は sticky で 1 回のはず: ${reimpl.length}`);
  assert.equal(reimpl[0].model, 'opus', 'sticky 後の reimpl#1 は最初から model:opus のはず');
});

test('[impl-fallback] (c) 再試行も null → 従来どおり drop 1、3 回目は呼ばれない', async () => {
  const { calls, logs, error } = await runFlow({ 'impl:serial:issue-1': null });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(byLabel(calls, 'impl:serial:issue-1').length, 2, 'fable + opus の 2 回で打ち切るはず');
  assert.ok(logs.some((l) => l.includes('impl: dev-implement-fable 1 件が失敗(null)')), 'drop の log が無い');
  assert.ok(logs.some((l) => l.includes('implement drop 1 件')), 'implDroppedCount=1 の log が無い');
});

test('[impl-fallback] (d) green-fix#1 は model:sonnet で spawn され、null でも再試行されない', async () => {
  const { calls, error } = await runFlow({
    'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' },
    'green-fix#1': null,
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const gf = byLabel(calls, 'green-fix#1');
  assert.equal(gf.length, 1, `green-fix#1 は 1 回のはず（fallback なし）: ${gf.length}`);
  assert.equal(gf[0].agentType, FABLE, 'green-fix の agent 定義は dev-implement-fable のまま');
  assert.equal(gf[0].model, 'sonnet', 'green-fix は model:sonnet の明示 override のはず');
  const gfRetry = byLabel(calls, 'green-fix#retry-1');
  for (const c of gfRetry) assert.equal(c.model, 'sonnet', 'green-fix#retry-i も model:sonnet のはず');
});

test('[impl-fallback] (e) fallbackModel を持たない call（eval#1）の null は 1 回のみで need() が abort する', async () => {
  const { calls, error } = await runFlow({ 'eval#1': null });
  assert.ok(error, 'eval#1 null は need() で abort するはず');
  assert.equal(byLabel(calls, 'eval#1').length, 1, 'eval#1 は再試行されない');
  assert.equal(byLabel(calls, 'eval#1')[0].model, null, 'evaluator は model override を持たない');
});

test('[impl-fallback] (f) telemetry: 成功 run — impl_model_config:fable、未発火なら impl_model_fallback_label 無し', async () => {
  const { payloads, error } = await runFlow();
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const t = payloads.at(-1).telemetry;
  assert.equal(t.impl_model_config, 'fable');
  assert.equal('impl_model_fallback_label' in t, false, `未発火なのに impl_model_fallback_label が載っている: ${t.impl_model_fallback_label}`);
});

test('[impl-fallback] (f) telemetry: 成功 run（発火）— impl_model_fallback_label は最初に落ちた label', async () => {
  const { payloads, error } = await runFlow({ 'impl:serial:issue-1': nullThenOk(1, IMPL_OK()) });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const t = payloads.at(-1).telemetry;
  assert.equal(t.impl_model_config, 'fable');
  assert.equal(t.impl_model_fallback_label, 'impl:serial:issue-1');
});

test('[impl-fallback] (f) telemetry: failure run（empty-diff、発火）— 失敗 handoff にも 2 キーが載る', async () => {
  const { payloads, error } = await runFlow({
    'impl:serial:issue-1': nullThenOk(1, IMPL_OK()),
    'diff-gate': { hash: 'H', empty: true },
    'diff-gate-retry': { hash: 'H', empty: true },
    'issue-labels': null,
  });
  assert.ok(error, 'empty-diff gate で throw するはず');
  const t = payloads.at(-1).telemetry;
  assert.equal(payloads.at(-1).outcome, 'failure');
  assert.equal(t.impl_model_config, 'fable');
  assert.equal(t.impl_model_fallback_label, 'impl:serial:issue-1');
});

test('[impl-fallback] (f) telemetry: abort run（eval#1 null、発火）— abort handoff にも 2 キーが載る', async () => {
  const { payloads, error } = await runFlow({ 'impl:serial:issue-1': nullThenOk(1, IMPL_OK()), 'eval#1': null });
  assert.ok(error, 'eval#1 null は abort するはず');
  const t = payloads.at(-1).telemetry;
  assert.equal(payloads.at(-1).error_category, 'abort');
  assert.equal(t.impl_model_config, 'fable');
  assert.equal(t.impl_model_fallback_label, 'impl:serial:issue-1');
});

test('[impl-fallback] (g) fallbackModel は agent() の opts に流れない', async () => {
  const { calls, error } = await runFlow({ 'impl:serial:issue-1': nullThenOk(1, IMPL_OK()) });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const leaked = calls.filter((c) => 'fallbackModel' in (c.opts ?? {}));
  assert.deepEqual(leaked.map((c) => c.label), [], 'fallbackModel が agent() の opts に残っている');
});
