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
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
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

// ============================================================
// C. Evaluate フェーズ replan: 衝突 plan で P2 が serial 降格されること
//    (design-feedback → replan → applyDisjoint → reimpl の経路を検証)
// ============================================================

test('[parallel-disjoint-routing] Evaluate replan: design feedback 後の衝突 plan で P2 が serial 降格される', async () => {
  // complex 経路を踏むための req（EVAL_PASSES = EVAL_MAX = 10 になる）
  const complexReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 10,
    shape: 'complex',
  };

  // replan で返す衝突 plan: P1/P2 が共に 'src/shared.ts' を触る
  const conflictPlan = {
    summary: 'p',
    serial: [],
    parallel: [
      { id: 'P1', desc: 'x', file_changes: ['src/shared.ts'] },
      { id: 'P2', desc: 'y', file_changes: ['src/shared.ts'] },
    ],
  };

  const calls = [];
  let evaluatorCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });

    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return complexReq;
    }
    if (agentType === 'dev-planner') {
      // Evaluate replan で衝突 plan を返す（初期 plan も同じで ok）
      return conflictPlan;
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return { hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      evaluatorCallCount += 1;
      if (evaluatorCallCount === 1) {
        // 1 回目: design レベルの問題を指摘して replan を要求
        return {
          verdict: 'fail',
          total: 40,
          threshold: 80,
          feedback: [{ severity: 'critical', dimension: 'design', topic: 'arch', description: 'redesign needed', suggestion: 'fix it' }],
          feedback_level: 'design',
          ac_results: [],
          security_clearance: [],
        };
      }
      // 2 回目以降: pass。critical_resolutions で EVAL-1-arch を解消する（issue #174 新設計）。
      return {
        verdict: 'pass',
        total: 90,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-arch', resolved: true, evidence: 'arch issue fixed: redesign implemented and verified' }],
      };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'LGTM' }),
    args: '1',
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

  const src = readFileSync(devFlowPath, 'utf8');
  const ctx = vm.createContext(sandbox);
  const err = await runDevFlowInSandbox(src, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }

  assert.equal(
    err,
    null,
    `dev-flow.js が予期せずエラーで終了: ${err}`,
  );

  // evaluator がちょうど 2 回呼ばれること（design replan → 解消 → 2 回で収束）
  assert.equal(
    evaluatorCallCount,
    2,
    `evaluator は 2 回で収束するべき（design replan → critical_resolutions 解消）。実際: ${evaluatorCallCount} 回`,
  );

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  const implLabels = implCalls.map((c) => c.label);

  // reimpl（Evaluate replan 後の実装）で P2 が :par:P2 で呼ばれていないこと
  const reimplParP2Calls = implLabels.filter((l) => l.startsWith('reimpl') && l.includes(':par:P2'));
  assert.equal(
    reimplParP2Calls.length,
    0,
    `Evaluate replan 後の衝突 P2 が parallel fan-out されてはいけない（reimpl*:par:P2 が 0 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );

  // reimpl で P2 が :serial:P2 で呼ばれていること（serial に降格して実行）
  const reimplSerialP2Calls = implLabels.filter((l) => l.startsWith('reimpl') && l.includes(':serial:P2'));
  assert.ok(
    reimplSerialP2Calls.length >= 1,
    `Evaluate replan 後の衝突 P2 が serial 実行されるべき（reimpl*:serial:P2 が >= 1 件のはず）。`
      + ` 実際の labels: ${implLabels.join(', ')}`,
  );
});
