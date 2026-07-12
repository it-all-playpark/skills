// final-ac-reconcile-routing: VM sandbox routing test for dev-flow の targeted Final AC
// reconcile phase（issue #331 G2）。pr-iterate が fix を適用した run（fixes_applied>0）かつ
// Final reconcile の final test が green/no_tests のときのみ、Analyze で freeze した既存
// acceptance_criteria を最終 PR tree に対し one-shot で再検証する targeted evaluator を起動し、
// classifyMergeTier / summary / telemetry / return が最終 AC snapshot（state.finalAcResults /
// state.finalUnsatisfiedAc）を参照することを pin する。
//
// ハーネスは _lib/final-reconcile-routing.test.mjs の構造（makeRecordingSandbox +
// createResponder + ローカル runDevFlowCapture + assertNoCrash + STANDARD_REQ + makeSandbox）
// を丸ごと踏襲する。
//
// テストケース:
//   (r1) fixes=0 → 'final-ac-reconcile' 不発 + final_ac_reconcile==='skipped' + merge_tier==='REVIEW'
//   (r2) fixes=1 + test#final green → 'final-ac-reconcile' が 1 回だけ呼ばれ reverified + REVIEW
//        + journal-log prompt に 'final_ac_reconcile'
//   (r3) fixes=1 + ac_results:null → unavailable + HOLD + reasons に 'Final AC reconcile 判定不能'
//   (r4) fixes=1 + ac_results で ac_index 重複 → unavailable + HOLD
//   (r5) fixes=1 + ac_index:1 が satisfied:false → reverified + HOLD + reasons に 'AC 未達'
//        + post-summary prompt に 'AC-FINAL-2' + result.final_unsatisfied_ac===true
//   (r6) fixes=1 + test#final red → 'final-ac-reconcile' 不発 + skipped + HOLD（'final test red'）
//        + post-summary prompt に 'AC 判定は stale'
//   (r7) acceptance_criteria:[] + fixes=1 → Analyze needs_clarification で早期終了 →
//        'final-ac-reconcile' 不発（agent 浪費ゼロの実証。acCount===0 の skip 判定自体は
//        _lib/final-ac-reconcile.test.mjs の shouldRunFinalAcReconcile 単体テストが決定論的に担保）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す
// （_lib/final-reconcile-routing.test.mjs と同型のローカル copy）
// ============================================================
async function runDevFlowCapture(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

// ============================================================
// responder factory: _lib/final-reconcile-routing.test.mjs の createResponder パターンを踏襲。
// 'final-ac-reconcile' 専用 default を agentType==='evaluator' fallback より前に置く。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-331' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (label === 'final-ac-reconcile') {
      return {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
          { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
        ],
      };
    }
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/x.ts'] };
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    return null;
  };
}

function makeSandbox({ overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '331',
  });
}

// ============================================================
// (r1) fixes_applied=0 → 'final-ac-reconcile' 不発 + skipped + merge_tier REVIEW
// ============================================================

test('[final-ac-reconcile] (r1) fixes_applied=0 → final-ac-reconcile 不発 + final_ac_reconcile===skipped + merge_tier REVIEW', async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 0 });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r1');
  assert.ok(result !== null, '(r1) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(r1) fixes_applied=0 では 'final-ac-reconcile' の呼び出しが存在してはならない");
  assert.equal(result?.final_ac_reconcile, 'skipped', `(r1) final_ac_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(r1) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (r2) fixes=1 + test#final green → final-ac-reconcile が1回だけ + reverified + REVIEW
//      + journal-log prompt に 'final_ac_reconcile'
// ============================================================

test('[final-ac-reconcile] (r2) fixes=1 + test#final green → final-ac-reconcile 1回 + reverified + merge_tier REVIEW + journal-log に final_ac_reconcile', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r2');
  assert.ok(result !== null, '(r2) workflow は return object を返すべきだが null だった');

  const facCalls = calls.filter((c) => c.label === 'final-ac-reconcile');
  assert.equal(facCalls.length, 1, `(r2) 'final-ac-reconcile' はちょうど1回呼ばれるはずだが ${facCalls.length} 回だった`);
  assert.equal(result?.final_ac_reconcile, 'reverified', `(r2) final_ac_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(r2) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(r2) 'journal-log' の呼び出しが存在すること");
  assert.ok(journalCall.prompt.includes('final_ac_reconcile'), "(r2) journal-log prompt に 'final_ac_reconcile' が含まれること");
});

// ============================================================
// (r3) fixes=1 + final-ac-reconcile が null → unavailable + HOLD + 'Final AC reconcile 判定不能'
// ============================================================

test("[final-ac-reconcile] (r3) fixes=1 + final-ac-reconcile null → unavailable + HOLD + 'Final AC reconcile 判定不能'", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'final-ac-reconcile': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r3');
  assert.ok(result !== null, '(r3) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_ac_reconcile, 'unavailable', `(r3) final_ac_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r3) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final AC reconcile 判定不能')),
    `(r3) merge_tier_reasons に 'Final AC reconcile 判定不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (r4) fixes=1 + ac_index 重複 → unavailable + HOLD
// ============================================================

test('[final-ac-reconcile] (r4) fixes=1 + ac_index 重複 → unavailable + HOLD', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'x' },
          { ac_index: 0, satisfied: true, evidence: 'y' },
        ],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r4');
  assert.ok(result !== null, '(r4) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_ac_reconcile, 'unavailable', `(r4) final_ac_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r4) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (r5) fixes=1 + ac_index:1 satisfied:false → reverified + HOLD + 'AC 未達'
//      + post-summary prompt に 'AC-FINAL-2' + result.final_unsatisfied_ac===true
// ============================================================

test("[final-ac-reconcile] (r5) fixes=1 + AC-2 不成立 → reverified + HOLD + 'AC 未達' + AC-FINAL-2 append + final_unsatisfied_ac", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'ok0' },
          { ac_index: 1, satisfied: false, evidence: 'fail1' },
        ],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r5');
  assert.ok(result !== null, '(r5) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_ac_reconcile, 'reverified', `(r5) final_ac_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r5) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('AC 未達')),
    `(r5) merge_tier_reasons に 'AC 未達' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.final_unsatisfied_ac, true, `(r5) final_unsatisfied_ac は true のはずだが ${JSON.stringify(result?.final_unsatisfied_ac)}`);

  const summaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(summaryCall, "(r5) 'post-summary' の呼び出しが存在すること");
  assert.ok(summaryCall.prompt.includes('AC-FINAL-2'), "(r5) post-summary prompt に 'AC-FINAL-2' が含まれること（critical append の実証）");
});

// ============================================================
// (r6) fixes=1 + test#final red → final-ac-reconcile 不発 + skipped + HOLD('final test red')
//      + post-summary prompt に 'AC 判定は stale'
// ============================================================

test("[final-ac-reconcile] (r6) fixes=1 + test#final red → final-ac-reconcile 不発 + skipped + HOLD + post-summary に 'AC 判定は stale'", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'failed', green: false, summary: 'boom' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r6');
  assert.ok(result !== null, '(r6) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(r6) final test red のとき 'final-ac-reconcile' が呼ばれてはならない");
  assert.equal(result?.final_ac_reconcile, 'skipped', `(r6) final_ac_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r6) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(r6) merge_tier_reasons に 'final test red' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );

  const summaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(summaryCall, "(r6) 'post-summary' の呼び出しが存在すること");
  assert.ok(summaryCall.prompt.includes('AC 判定は stale'), "(r6) post-summary prompt に 'AC 判定は stale' が含まれること");
});

// ============================================================
// (r7) acceptance_criteria:[] + fixes=1 → Analyze needs_clarification で早期終了 →
//      'final-ac-reconcile' 不発（agent 浪費ゼロの実証）
// ============================================================

test("[final-ac-reconcile] (r7) acceptance_criteria:[] → Analyze needs_clarification で早期終了 → final-ac-reconcile 不発", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'analyze#331': { ...STANDARD_REQ, acceptance_criteria: [] } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r7');
  assert.ok(result !== null, '(r7) workflow は return object を返すべきだが null だった');
  assert.equal(result?.status, 'needs_clarification', `(r7) status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)}`);

  // acCount===0 の skip 判定自体は _lib/final-ac-reconcile.test.mjs の shouldRunFinalAcReconcile
  // 単体テストが決定論的に担保する（no_ac reason）。ここでは Analyze 早期終了により
  // final-ac-reconcile agent が一切起動しない（agent 浪費ゼロ）ことのみを確認する。
  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(r7) needs_clarification 早期終了時は 'final-ac-reconcile' が呼ばれてはならない");
});
