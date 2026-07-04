// 負の制御群テスト（green-fix 0 回経路）。
// green-fix が一度も発生しない run では evaluator prompt に「テスト弱体化」focus が
// 注入されないことを pin する。このテストは F3 実装前から green で正しい（F1 が red を担う）。
// F3 実装後も引き続き green であること（誤って負の制御群に focus が混入しないことを保証する）。

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
// responder: green-fix なし経路専用の agent 応答
// test runner（label startsWith 'test'）は常に passed (green:true) を返すため
// green-fix 経路に入らない。
// ============================================================

function responder({ label, agentType }) {
  // Setup(worktree)
  // Setup(resolve-base): base 解決 probe（issue #298）
  if (label === 'resolve-base') {
    return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
  }
  if (label === 'worktree') {
    return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
  }
  // Analyze: label が 'analyze' で始まる
  if (label.startsWith('analyze')) {
    return {
      summary: 's',
      acceptance_criteria: ['a', 'b', 'c', 'd'],
      issue_type: 'fix',
      scope: 'src',
      estimated_change_file_count: 3,
      shape: 'standard',
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
  // Security floor / danger-grep 系
  if (label.startsWith('danger-grep')) {
    return { ok: true, hits: [] };
  }
  // Validate: test runner（label が 'test' で始まる）
  // 常に passed (green:true) を返す — green-fix 経路に入らない
  if (label.startsWith('test')) {
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
  // realized-diff / declared-path-check / changed-files → files: [] で refloor を standard 維持
  if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
    return { files: [] };
  }
  // PR 系: label が 'pr' で始まる
  if (label.startsWith('pr')) {
    return { pr_url: 'http://x', pr_number: 1, committed: true };
  }
  // implementer
  if (agentType === 'implementer') {
    return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
  }
  // diff-gate / diff-hash（issue #215）: need() による throw の回避
  if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
    return { hash: 'H', empty: false };
  }
  // デフォルト
  return null;
}

// ============================================================
// 共有実行（複数テストが同じ sandbox 実行結果を参照するため）
// ============================================================

let sharedCalls = null;
let sharedErr = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(responder);
  const err = await runDevFlowInSandbox(src, ctx);
  sharedCalls = calls;
  sharedErr = err;
}

// ============================================================
// crash guard: ReferenceError / SyntaxError なら assert.fail
// ============================================================

test('[green-fix-no-audit] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedErr && (sharedErr.name === 'ReferenceError' || sharedErr.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedErr.name}: ${sharedErr.message}`);
  }
});

// ============================================================
// テスト 1: sanity — green-fix label で始まる call が 0 件であること
// ============================================================

test('[green-fix-no-audit] sanity: label が green-fix で始まる call が 0 件であること', async () => {
  await ensureSharedRun();
  const greenFixCalls = sharedCalls.filter((c) => c.label.startsWith('green-fix'));
  assert.equal(
    greenFixCalls.length,
    0,
    `green-fix label の call が 0 件であるべきだが ${greenFixCalls.length} 件あった`
      + ` (labels: ${greenFixCalls.map((c) => c.label).join(', ')})`,
  );
});

// ============================================================
// テスト 2: 主検証（AC#2）— evaluator prompt に「テスト弱体化」が含まれないこと
// ============================================================

test('[green-fix-no-audit] AC#2: green-fix 0 回経路では evaluator の prompt に「テスト弱体化」が含まれないこと', async () => {
  await ensureSharedRun();
  const evaluatorCalls = sharedCalls.filter((c) => c.agentType === 'evaluator');

  // evaluator が 1 回以上呼ばれていないと負の検証が無意味になる
  assert.ok(
    evaluatorCalls.length >= 1,
    `evaluator は 1 回以上呼ばれるべきだが ${evaluatorCalls.length} 回だった`
      + ` (全 agentTypes: ${sharedCalls.map((c) => c.agentType).join(', ')})`,
  );

  // green-fix なし経路では evaluator prompt にテスト弱体化 focus が注入されないこと
  const withAuditFocus = evaluatorCalls.filter((c) => c.prompt.includes(TEST_WEAKENING));
  assert.equal(
    withAuditFocus.length,
    0,
    `green-fix 0 回経路: evaluator の prompt に「テスト弱体化」が含まれてはいけないが`
      + ` ${withAuditFocus.length} 件含まれていた`
      + `\n最初の該当 prompt (先頭300文字):\n${withAuditFocus[0]?.prompt.slice(0, 300) ?? ''}`,
  );
});
