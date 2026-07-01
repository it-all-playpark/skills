// micro shape（TRIVIAL）+ green-fix 発生時に Evaluate が強制実行されることを検証するテスト。
// commit d380d9f で追加した `|| greenFixCount > 0` 分岐（runEval フラグ）の regression guard。
//
// テスト構成:
//   - analyze stub が shape: 'micro' / estimated_change_file_count: 1 を返す
//   - realized-diff stub が files: ['src/foo.ts']（1 ファイル）を返す → refloor で micro 維持
//   - test stub は 1 回目 fail → green-fix#1 発生 → 2 回目 pass
//   - dangerHits は空（danger path ではなく green-fix path で Evaluate が強制されることを確認）
//
// 検証すること:
//   1. evaluator が 1 回以上呼ばれること（TRIVIAL + green-fix で runEval=true になること）
//   2. evaluator の prompt に「テスト弱体化」focus が含まれること

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';
import { TEST_WEAKENING } from './test-helpers/dev-flow-markers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ============================================================
// responder: micro shape + green-fix あり経路専用の agent 応答
// - analyze: shape: 'micro', estimated_change_file_count: 1
// - realized-diff: files: ['src/foo.ts']（1 ファイル → refloor で micro 維持）
// - test runner: 1 回目 fail、2 回目 pass（testCallCount クロージャ状態を内包）
// - green-fix implementer: files / summary を返す
// ============================================================

function createResponder() {
  let testCallCount = 0;
  return function({ label, agentType }) {
    // Setup(worktree)
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: micro shape, 1 ファイル
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a'],
        issue_type: 'fix',
        scope: 'src',
        estimated_change_file_count: 1,
        shape: 'micro',
      };
    }
    // Plan: dev-planner
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // danger-grep: 空（danger path ではない）
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // realized-diff: 1 ファイル → refloor で micro 維持
    if (label === 'realized-diff') {
      return { files: ['src/foo.ts'] };
    }
    // declared-path-check / changed-files
    if (label === 'declared-path-check' || label === 'changed-files') {
      return { files: [] };
    }
    // Validate: test runner — 1 回目 fail、2 回目 pass
    if (label.startsWith('test')) {
      testCallCount += 1;
      if (testCallCount === 1) {
        return { tests: 'failed', green: false, summary: 'assert mismatch in foo.test' };
      }
      return { tests: 'passed', green: true, summary: '' };
    }
    // Evaluate: evaluator
    if (agentType === 'evaluator') {
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
    // PR 系
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // implementer（green-fix も含む）
    if (agentType === 'implementer' && label.startsWith('green-fix')) {
      return { status: 'DONE', task_id: 't', files: ['src/foo.test.ts'], summary: 'typo修正', concerns: [] };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    return null;
  };
}

// ============================================================
// 共有実行（micro + green-fix sandbox）
// ============================================================

let sharedCalls = null;
let sharedErr = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(createResponder());
  const err = await runDevFlowInSandbox(src, ctx);
  sharedCalls = calls;
  sharedErr = err;
}

// ============================================================
// crash guard
// ============================================================

test('[green-fix-micro-eval] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedErr && (sharedErr.name === 'ReferenceError' || sharedErr.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedErr.name}: ${sharedErr.message}`);
  }
});

// ============================================================
// sanity: micro shape で green-fix が 1 回発生すること
// ============================================================

test('[green-fix-micro-eval] sanity: micro shape で green-fix が 1 回発生すること', async () => {
  await ensureSharedRun();
  const greenFixCalls = sharedCalls.filter((c) => c.label.startsWith('green-fix'));
  assert.ok(
    greenFixCalls.length >= 1,
    `green-fix label の call が 1 回以上発生すべきだが ${greenFixCalls.length} 回だった`
      + ` (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
});

// ============================================================
// 主検証 1: micro + green-fix 発生時に evaluator が呼ばれること
// （TRIVIAL=true かつ dangerHits=[] でも greenFixCount>0 で runEval=true になることの確認）
// ============================================================

test('[green-fix-micro-eval] micro + green-fix 発生時に evaluator が 1 回以上呼ばれること', async () => {
  await ensureSharedRun();
  const evaluatorCalls = sharedCalls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `micro + green-fix 発生時: evaluator は 1 回以上呼ばれるべきだが ${evaluatorCalls.length} 回だった`
      + ` (全 agentTypes: ${sharedCalls.map((c) => c.agentType).join(', ')})`,
  );
});

// ============================================================
// 主検証 2: micro + green-fix 発生時に evaluator の prompt に「テスト弱体化」focus が含まれること
// ============================================================

test('[green-fix-micro-eval] micro + green-fix 発生時に evaluator の prompt に「テスト弱体化」が含まれること', async () => {
  await ensureSharedRun();
  const evaluatorCalls = sharedCalls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `evaluator が呼ばれていない (全 agentTypes: ${sharedCalls.map((c) => c.agentType).join(', ')})`,
  );
  const withFocus = evaluatorCalls.filter((c) => c.prompt.includes(TEST_WEAKENING));
  assert.ok(
    withFocus.length >= 1,
    `micro + green-fix 発生時: evaluator の prompt に「テスト弱体化」が含まれるべきだが含まれていない`
      + `\nevaluator prompt (先頭600文字):\n${evaluatorCalls[0]?.prompt.slice(0, 600) ?? ''}`,
  );
});
