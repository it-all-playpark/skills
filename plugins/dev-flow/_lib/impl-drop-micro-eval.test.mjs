// micro shape（TRIVIAL）+ implementer drop 発生時に Evaluate が強制実行されることを検証するテスト。
// `|| state.implDroppedCount > 0` 分岐（runEval フラグ）の regression guard（issue #540）。
//
// 守っている不変条件:
//   implementer が null を返して task が落ちた run は「計画した実装範囲」が実際には欠けている。
//   残った task の diff が非空なら empty-diff gate も refloor も素通りするため、この分岐が無いと
//   micro では evaluator 0 回のまま AC 未検証で PR に到達する。
//
// テスト構成（2 シナリオを別 sandbox で実行）:
//   - drop あり: parallel T1 が null（drop）/ parallel T2 は DONE / serial T3 が null（drop）
//     → implDroppedCount=2 → evaluator が呼ばれること
//   - drop なし（対照群）: 全 task DONE → implDroppedCount=0 → evaluator が呼ばれないこと
//     （drop=0 のとき現行と挙動が一致することの pin。分岐が常時 true に退化していないことを示す）
//
// どちらのシナリオも danger clean / testsurf なし / green-fix なし / 宣言外なし / UI touch なしに
// 揃えてあり、runEval を動かす要因を implDroppedCount だけに絞っている。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ============================================================
// responder: micro shape 固定。dropLabels に含まれる label だけ null を返す。
// ============================================================

function createResponder(dropLabels) {
  return function({ label, agentType }) {
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: micro shape（1 ファイル / AC 1 件）
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a'],
        issue_type: 'fix',
        scope: 'src',
        estimated_change_file_count: 1,
        shape: 'micro',
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    // Plan: parallel 2 task + serial 1 task。file_changes は realized-diff stub と一致させ
    // 宣言外検出（issue #272 F2）を発火させない（runEval の要因を drop だけに絞るため）。
    if (agentType === 'dev-flow:dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 'T3', desc: 't3', file_changes: ['src/foo.ts'], test_plan: '' }],
        parallel: [
          { id: 'T1', desc: 't1', file_changes: ['src/foo.ts'], test_plan: '' },
          { id: 'T2', desc: 't2', file_changes: ['src/foo.ts'], test_plan: '' },
        ],
      };
    }
    if (agentType === 'dev-flow:plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // label 'danger-grep'（issue #544 統合呼び出し）: clean（security path ではないことを保証）+
    // files 1 件（旧 realized-diff 相当 → refloor で micro 維持）。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/foo.ts'], struct: null, diffhash: null };
    }
    if (label === 'danger-grep-final') {
      return { ok: true, hits: [] };
    }
    if (label === 'changed-files') {
      return { files: [] };
    }
    // Validate: 一発 green（green-fix を発火させない）
    if (label.startsWith('test')) {
      return { tests: 'passed', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // implementer: dropLabels に一致するものだけ null（= drop）を返す
    if (agentType === 'dev-flow:implementer') {
      if (dropLabels.includes(label)) return null;
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };
}

async function runScenario(dropLabels) {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(createResponder(dropLabels));
  const err = await runDevFlowInSandbox(src, ctx);
  return { calls, err };
}

// drop あり: parallel T1 と serial T3 が null（dropped=1 + serialDropped=1）
const DROP_LABELS = ['impl:par:T1', 'impl:serial:T3'];

let dropRun = null;
let cleanRun = null;

async function ensureDropRun() {
  if (dropRun === null) dropRun = await runScenario(DROP_LABELS);
}
async function ensureCleanRun() {
  if (cleanRun === null) cleanRun = await runScenario([]);
}

// ============================================================
// crash guard
// ============================================================

test('[impl-drop-micro-eval] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureDropRun();
  const { err } = dropRun;
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }
});

// ============================================================
// sanity: drop シナリオで implementer の null 応答が実際に発生していること
// ============================================================

test('[impl-drop-micro-eval] sanity: drop 対象の implementer call が実際に発生していること', async () => {
  await ensureDropRun();
  const dropped = dropRun.calls.filter((c) => DROP_LABELS.includes(c.label));
  assert.ok(
    dropped.length >= 1,
    `drop 対象 label の implementer call が発生すべきだが 0 件だった`
      + ` (全 labels: ${dropRun.calls.map((c) => c.label).join(', ')})`,
  );
});

// ============================================================
// 主検証 1: micro + implementer drop で evaluator が呼ばれること
// ============================================================

test('[impl-drop-micro-eval] micro + implementer drop 発生時に evaluator が 1 回以上呼ばれること', async () => {
  await ensureDropRun();
  const evaluatorCalls = dropRun.calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `micro + implementer drop 発生時: evaluator は 1 回以上呼ばれるべきだが ${evaluatorCalls.length} 回だった`
      + ` (全 agentTypes: ${dropRun.calls.map((c) => c.agentType).join(', ')})`,
  );
});

// ============================================================
// 主検証 2（対照群）: drop が無ければ evaluator は呼ばれないこと
// この分岐が常時 true に退化していない（drop=0 で現行挙動と一致する）ことの pin
// ============================================================

test('[impl-drop-micro-eval] drop が無い micro run では evaluator が呼ばれないこと（現行挙動の維持）', async () => {
  await ensureCleanRun();
  const evaluatorCalls = cleanRun.calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(
    evaluatorCalls.length,
    0,
    `drop なしの clean micro run では evaluator は呼ばれないべきだが ${evaluatorCalls.length} 回呼ばれた`
      + ` (全 agentTypes: ${cleanRun.calls.map((c) => c.agentType).join(', ')})`,
  );
});
