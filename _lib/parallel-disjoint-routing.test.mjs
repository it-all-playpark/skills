// VM カウントテスト: parallel-disjoint-routing
//
// 衝突 plan を返す planner stub で衝突 task が serial 実行される（parallel fan-out されない）ことを
// implementer call label カウントで検証する。
//
// 【ハーネス】shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox を流用。
// 【依存】F1（applyDisjoint を dev-flow.js に組み込み）/ F3（enforceDisjointParallel の実装）。
//
// TDD red 条件: F3 適用前は P2 が `:par:P2` で呼ばれるため衝突テストが red。
//               F3 適用後 P2 が `:serial:P2` になり green。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox と同型） ----

/**
 * parallel-disjoint-routing 専用の VM sandbox を組む。
 * agent() を呼び出しカウンタ stub にし、calls 配列を expose する。
 * plannerPlan を注入して dev-planner が返す plan を制御する（衝突 / 非衝突検証用）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} plannerPlan - dev-planner が返す plan（衝突あり/なしを切り替える）
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string}> }}
 */
function makeCountingSandbox(analyzeReq, plannerPlan) {
  const calls = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });

    // Setup(worktree)
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan: dev-planner（衝突 / 非衝突 plan を注入）
    if (agentType === 'dev-planner') {
      return plannerPlan;
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    if (label.startsWith('danger-grep')) {
      return { hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
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
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // implementer その他
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // デフォルト
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'LGTM' }),
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（makeWorkflowSandbox と同一セット）
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * shape-loop-routing.test.mjs の runDevFlowInSandbox と同型。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<Error|null>} エラーがあれば Error、無ければ null
 */
async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      await result.catch((e) => {
        caughtError = e;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return caughtError;
}

// standard に落ちる req（count=3, ac 4件, issue_type='feat', scope/summary に breaking 無し）
// shape-loop-routing.test.mjs の standardReq と同型
const standardReq = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

// ============================================================
// A. 衝突検証: 衝突 plan で P2 が serial 実行・par 実行されないこと
// ============================================================

test('[parallel-disjoint-routing] 衝突 plan: P2 が :par: で呼ばれず :serial: で呼ばれる', async () => {
  // file_changes が衝突する parallel: P1/P2 どちらも 'src/shared.ts' を触る
  const conflictPlan = {
    summary: 'p',
    serial: [],
    parallel: [
      { id: 'P1', desc: 'x', file_changes: ['src/shared.ts'] },
      { id: 'P2', desc: 'y', file_changes: ['src/shared.ts'] },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, conflictPlan);
  const err = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }

  // workflow が最後まで走ること（エラーなし）
  assert.equal(
    err,
    null,
    `dev-flow.js が予期せずエラーで終了: ${err}`,
  );

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  const implLabels = implCalls.map((c) => c.label);

  // P2 が :par:P2 で呼ばれていないこと（衝突 task が parallel fan-out されない）
  const parP2Calls = implLabels.filter((l) => l.includes(':par:P2'));
  assert.equal(
    parP2Calls.length,
    0,
    `衝突した P2 が parallel fan-out されてはいけない（:par:P2 が 0 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );

  // P2 が :serial:P2 で呼ばれていること（serial に降格して実行）
  const serialP2Calls = implLabels.filter((l) => l.includes(':serial:P2'));
  assert.ok(
    serialP2Calls.length >= 1,
    `衝突した P2 が serial 実行されるべき（:serial:P2 が >= 1 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );
});

// ============================================================
// B. 非衝突対照: 非衝突 plan で P1/P2 が共に :par: で呼ばれること
// ============================================================

test('[parallel-disjoint-routing] 非衝突 plan: P1/P2 が共に :par: で呼ばれ :serial:P は存在しない', async () => {
  // file_changes が衝突しない parallel: P1 は 'src/a.ts'、P2 は 'src/b.ts'
  const nonConflictPlan = {
    summary: 'p',
    serial: [],
    parallel: [
      { id: 'P1', desc: 'x', file_changes: ['src/a.ts'] },
      { id: 'P2', desc: 'y', file_changes: ['src/b.ts'] },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, nonConflictPlan);
  const err = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }

  // workflow が最後まで走ること（エラーなし）
  assert.equal(
    err,
    null,
    `dev-flow.js が予期せずエラーで終了: ${err}`,
  );

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  const implLabels = implCalls.map((c) => c.label);

  // P1/P2 が共に :par: で呼ばれること（降格が起きない）
  const parP1Calls = implLabels.filter((l) => l.includes(':par:P1'));
  assert.ok(
    parP1Calls.length >= 1,
    `非衝突 P1 が parallel 実行されるべき（:par:P1 が >= 1 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );

  const parP2Calls = implLabels.filter((l) => l.includes(':par:P2'));
  assert.ok(
    parP2Calls.length >= 1,
    `非衝突 P2 が parallel 実行されるべき（:par:P2 が >= 1 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );

  // :serial:P1 / :serial:P2 が存在しないこと（降格が起きない）
  const serialPCalls = implLabels.filter((l) => /serial:P[12]/.test(l));
  assert.equal(
    serialPCalls.length,
    0,
    `非衝突 plan では P1/P2 が serial 降格されてはいけない（:serial:P が 0 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );
});
