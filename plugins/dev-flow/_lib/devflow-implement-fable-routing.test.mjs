// IMPLEMENT_MODE（_lib/implement-mode.mjs）による standard shape の Implement 経路切替を
// dev-flow.js 全体の VM 実行で pin する（issue #668）。shape × IMPLEMENT_MODE の組合せと
// Evaluate 差し戻し（reimpl#i）経路を agent stub の呼び出し列・prompt 文字列で検証する。
//
//   AC-1: standard × fable → dev-planner 0 回・dev-implement-fable 1 回（Implement）
//   AC-2: standard × planner → plan#standard 1 発 → implementer（挙動不変）
//   AC-3: complex / micro は IMPLEMENT_MODE に依らず dev-implement-fable 0 回
//   AC-4: reimpl#i が fix_feedback 付きで dev-implement-fable に渡り、返却 task_id が合成 task id と一致
//   AC-5: prompt に issue_body + acceptance_criteria が含まれ、AC_TEST_CONTRACT は含まれない
//   AC-7: 両値で走る（withImplementMode でソースの定数行を書き換える）
//
// 責務外: telemetry の by_type / plan_iter は subagent-invocations-telemetry.test.mjs（#668 ケース）が pin する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, withImplementMode } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const FABLE = 'dev-flow:dev-implement-fable';
const PLANNER = 'dev-flow:dev-planner';
const IMPLEMENTER = 'dev-flow:implementer';

const ISSUE_BODY = '## 背景\n本文の一段落。\n\n## 受け入れ基準\n- [ ] a\n- [ ] b';
const AC = ['ac-one', 'ac-two', 'ac-three', 'ac-four'];

// contract-probe は既定 responder が null を返す（sonnet fallback）ため、req は 'analyze#1' override で注入する。
// issue_title は既定 issue-meta の title と一致させる（provenance 突合）。
function reqOf(shape) {
  const base = { summary: 's', scope: 'src', issue_number: 1, issue_title: 'stub-issue-title', issue_body: ISSUE_BODY, issue_body_truncated: false, ambiguities: [] };
  if (shape === 'micro') return { ...base, acceptance_criteria: ['a', 'b'], issue_type: 'fix', estimated_change_file_count: 1, shape: 'micro' };
  if (shape === 'complex') return { ...base, acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], issue_type: 'feat', estimated_change_file_count: 8, shape: 'complex' };
  return { ...base, acceptance_criteria: AC, issue_type: 'feat', estimated_change_file_count: 3, shape: 'standard' };
}

async function runFlow(mode, shape, overrides = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { 'analyze#1': reqOf(shape), ...overrides } });
  const { result, error } = await runWorkflowCapture(withImplementMode(src, mode), ctx);
  assertNoCrash(error, `${shape}/${mode}`);
  return { calls, logs, result, error };
}

const byType = (calls, t) => calls.filter((c) => c.agentType === t);
const implCalls = (calls, t) => calls.filter((c) => c.agentType === t && /^(impl|reimpl)/.test(c.label));

// ============================================================
// AC-1 / AC-5: standard × fable
// ============================================================
test('[implement-fable] standard × fable: dev-planner 0 回・dev-implement-fable 1 回（impl:serial:issue-1）・implementer 0 回', async () => {
  const { calls, logs, error } = await runFlow('fable', 'standard');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(byType(calls, PLANNER).length, 0, `dev-planner は 0 回のはず: ${byType(calls, PLANNER).map((c) => c.label).join(', ')}`);
  const fable = byType(calls, FABLE);
  assert.deepEqual(fable.map((c) => c.label), ['impl:serial:issue-1'], `dev-implement-fable は Implement で 1 回のはず: ${fable.map((c) => c.label).join(', ')}`);
  assert.equal(implCalls(calls, IMPLEMENTER).length, 0, 'Implement で implementer は起動しないはず');
  assert.ok(logs.some((l) => l.includes('plan#fable-skip')), 'plan#fable-skip の log が無い');
  // 返却 files（src/x.ts）が宣言として取り込まれるため、realized（danger-grep の src/x.ts）は宣言外にならない
  assert.ok(logs.some((l) => l.includes('宣言外変更なし')), `declared-path-check が宣言外なしにならない: ${logs.filter((l) => l.includes('宣言外')).join(' | ')}`);
  assert.ok(!logs.some((l) => l.includes('件が plan の file_changes に無い')), '宣言外変更 concern が注入された（返却 files が宣言として取り込まれていない）');
});

test('[implement-fable] AC-5: dev-implement-fable の prompt に issue_body・acceptance_criteria・task_id・配置規約が含まれ、AC テスト契約は含まれない', async () => {
  const { calls } = await runFlow('fable', 'standard');
  const [call] = byType(calls, FABLE);
  assert.ok(call, 'dev-implement-fable の call が無い');
  assert.ok(call.prompt.includes(ISSUE_BODY), 'prompt に issue_body（req.issue_body）が含まれない');
  assert.ok(call.prompt.includes(JSON.stringify(AC)), 'prompt に acceptance_criteria が含まれない');
  assert.ok(call.prompt.includes('task_id: issue-1'), 'prompt に合成 task の task_id が含まれない');
  assert.ok(call.prompt.includes('一時/handoff ファイルの配置規約'), 'prompt に STAGING_CONVENTION が含まれない');
  assert.ok(!call.prompt.includes('AC テスト契約'), 'prompt に AC_TEST_CONTRACT（red→green 自己実証）が含まれている');
  assert.ok(!call.prompt.includes('次の task を実装せよ'), 'prompt が implementer 向け手順書型になっている');
});

test('[implement-fable] issue_body_truncated:true → prompt に切詰め注記が付く / issue_body 欠落 → 本文なし注記', async () => {
  const truncated = await runFlow('fable', 'standard', { 'analyze#1': { ...reqOf('standard'), issue_body_truncated: true } });
  const [t] = byType(truncated.calls, FABLE);
  assert.ok(t.prompt.includes('切詰め済み'), 'issue_body_truncated:true の注記が無い');
  const missing = await runFlow('fable', 'standard', { 'analyze#1': (() => { const r = reqOf('standard'); delete r.issue_body; delete r.issue_body_truncated; return r; })() });
  const [m] = byType(missing.calls, FABLE);
  assert.ok(m.prompt.includes('issue 本文: analyze 出力に含まれていない'), 'issue_body 欠落時の注記が無い');
});

// ============================================================
// AC-2 / AC-7: standard × planner（ロールバック値）
// ============================================================
test('[implement-fable] standard × planner: plan#standard 1 発（dev-planner）→ implementer、dev-implement-fable 0 回', async () => {
  const { calls, logs, error } = await runFlow('planner', 'standard');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.deepEqual(byType(calls, PLANNER).map((c) => c.label), ['plan#standard'], 'dev-planner は plan#standard の 1 回のはず');
  assert.ok(implCalls(calls, IMPLEMENTER).length >= 1, 'implementer が Implement で起動していない');
  assert.equal(byType(calls, FABLE).length, 0, 'planner 値で dev-implement-fable が起動した');
  assert.ok(!logs.some((l) => l.includes('plan#fable-skip')), 'planner 値で plan#fable-skip が log された');
});

// ============================================================
// AC-3: complex / micro は IMPLEMENT_MODE に依らず不変
// ============================================================
for (const mode of ['fable', 'planner']) {
  test(`[implement-fable] complex × ${mode}: dev-implement-fable 0 回・dev-planner ⇄ plan-reviewer loop は起動`, async () => {
    const { calls } = await runFlow(mode, 'complex');
    assert.equal(byType(calls, FABLE).length, 0, `complex/${mode}: dev-implement-fable が起動した`);
    assert.ok(byType(calls, PLANNER).length >= 1, `complex/${mode}: dev-planner が起動していない`);
    assert.ok(byType(calls, 'dev-flow:plan-reviewer').length >= 1, `complex/${mode}: plan-reviewer が起動していない`);
  });

  test(`[implement-fable] micro × ${mode}: dev-implement-fable 0 回・plan#trivial 1 発`, async () => {
    const { calls } = await runFlow(mode, 'micro');
    assert.equal(byType(calls, FABLE).length, 0, `micro/${mode}: dev-implement-fable が起動した`);
    assert.deepEqual(byType(calls, PLANNER).map((c) => c.label), ['plan#trivial'], `micro/${mode}: dev-planner は plan#trivial の 1 回のはず`);
  });
}

// ============================================================
// AC-4: Evaluate 差し戻し（reimpl#i）
// standard の EVAL_PASSES は 1 のため、realized 6 files で complex へ refloor させて差し戻し loop に入れる
// （refloor-shape-routing (B) と同じ機構）。evaluator は 1 回目 fail（design）/ 2 回目 pass。
// ============================================================
test('[implement-fable] AC-4: reimpl#1 が fix_feedback 付きで dev-implement-fable に渡り、dev-planner の replan は起動せず、返却 task_id が合成 task id と一致する', async () => {
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];
  // critical で ledger に EVAL-1-arch-split が立ち、eval#2 の critical_resolutions で解消されるまで収束しない
  // （major のみだと blocking item が無く iter 1 で収束し差し戻しに入らない）
  const FEEDBACK = [{ topic: 'arch-split', severity: 'critical', dimension: 'design', description: 'split the module boundary', suggestion: 'move x to y' }];
  const echoed = [];
  const fableStub = ({ prompt }) => {
    const m = prompt.match(/task_id: (\S+?)（/);
    echoed.push(m ? m[1] : null);
    return { status: 'DONE', task_id: m ? m[1] : 'unknown', files: SIX, summary: 's', concerns: [] };
  };
  const { calls, error } = await runFlow('fable', 'standard', {
    'impl:serial:issue-1': fableStub,
    'reimpl#1:serial:issue-1': fableStub,
    'danger-grep': { risk: { ok: true, hits: [] }, files: SIX, struct: null, diffhash: { hash: 'AAA', empty: false } },
    'eval#1': { verdict: 'fail', total: 50, threshold: 80, feedback: FEEDBACK, feedback_level: 'design', ac_results: [], security_clearance: [], concern_resolutions: [] },
    'eval#2': { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [], concern_resolutions: [], critical_resolutions: [{ id: 'EVAL-1-arch-split', resolved: true, evidence: 'boundary split and verified' }] },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const reimpl = calls.filter((c) => c.label === 'reimpl#1:serial:issue-1');
  assert.equal(reimpl.length, 1, `reimpl#1:serial:issue-1 は 1 回のはず: ${calls.filter((c) => c.label.startsWith('reimpl')).map((c) => c.label).join(', ')}`);
  assert.equal(reimpl[0].agentType, FABLE, `reimpl#1 の agentType が ${reimpl[0].agentType}`);
  assert.ok(reimpl[0].prompt.includes('fix_feedback'), 'reimpl#1 prompt に fix_feedback が無い');
  assert.ok(reimpl[0].prompt.includes('split the module boundary'), 'reimpl#1 prompt に evaluator feedback の本文が無い');
  assert.equal(byType(calls, PLANNER).length, 0, `fable 経路の差し戻しで dev-planner が起動した: ${byType(calls, PLANNER).map((c) => c.label).join(', ')}`);
  assert.equal(implCalls(calls, IMPLEMENTER).length, 0, '差し戻しで implementer が起動した');
  assert.deepEqual(echoed, ['issue-1', 'issue-1'], `Implement / reimpl の両 prompt が合成 task id を渡すはず: ${JSON.stringify(echoed)}`);
});
