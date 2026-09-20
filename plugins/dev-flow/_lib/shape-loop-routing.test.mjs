// AC#7 は plan-reviewer 呼び出し0回・evaluator 呼び出し1回の実カウントで検証する（string-pattern ではなく挙動を pin）
//
// このテストファイルは TDD red として作成された。
// F1 時点では dev-flow.js に PLAN_SOLO / plan#standard / EVAL_PASSES が未実装のため、
// (A) のカウント assert（plan-reviewer=0 / evaluator=1）および (B) の構造 assert が fail する（= 赤）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, withImplementMode } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（workflow-load-smoke.test.mjs の makeWorkflowSandbox / runWorkflowInSandbox と同型）----

/**
 * shape-loop-routing 専用の VM sandbox を組む。
 * agent() を呼び出しカウンタ stub にし、calls 配列を expose する。
 * analyzeReq を注入して classify 結果を制御する（shape 別ルーティング検証用）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string}> }}
 */
function makeCountingSandbox(analyzeReq) {
  const calls = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });

    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan: dev-planner (plan#trivial / plan#standard / plan#N / replan 系)
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'dev-flow:plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator
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
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // implementer その他
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
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
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    // 引数（ISSUE 解決用）
    args: devFlowArgs('1'),
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
 * workflow-load-smoke.test.mjs の runWorkflowInSandbox と同型。
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

// ============================================================
// A. 振る舞いカウント検証（AC#7 主検証）
// ============================================================

test('[shape-loop] SHAPE=standard: plan-reviewer 呼び出し 0 回・evaluator 呼び出し 1 回', async () => {
  // standard に落ちる req（count=3 ≤ 5, ac.length=4 ≤ 6, type=feat → floor='standard'）
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // IMPLEMENT_MODE を 'planner' に固定（従来経路 dev-planner ⇄ plan-reviewer → implementer を pin する。
  // 全 shape の 'fable' 経路は devflow-implement-fable-routing.test.mjs が検証する。issue #670）
  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');
  const { ctx, calls } = makeCountingSandbox(standardReq);
  const err = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }

  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:plan-reviewer');
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');

  // AC#7 主検証: standard では plan-reviewer を呼ばない（PLAN_SOLO 経路）
  assert.equal(
    reviewerCalls.length,
    0,
    `SHAPE=standard: plan-reviewer は 0 回呼ばれるべきだが ${reviewerCalls.length} 回呼ばれた`
      + ` (labels: ${reviewerCalls.map((c) => c.label).join(', ')})`,
  );

  // AC#7 主検証: standard では evaluator を 1 回だけ呼ぶ（EVAL_PASSES=1）
  assert.equal(
    evaluatorCalls.length,
    1,
    `SHAPE=standard: evaluator は 1 回呼ばれるべきだが ${evaluatorCalls.length} 回呼ばれた`,
  );
});

test('[shape-loop] SHAPE=complex: plan-reviewer 呼び出し >= 1（制御群）', async () => {
  // complex に落ちる req（count=8 > 5 → floor='complex', ac=7件）
  const complexReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 8,
    shape: 'complex',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // IMPLEMENT_MODE を 'planner' に固定（従来経路 dev-planner ⇄ plan-reviewer → implementer を pin する。
  // 全 shape の 'fable' 経路は devflow-implement-fable-routing.test.mjs が検証する。issue #670）
  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');
  const { ctx, calls } = makeCountingSandbox(complexReq);
  const err = await runDevFlowInSandbox(src, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }

  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:plan-reviewer');

  // 制御群: complex では plan-reviewer が起動する経路（>= 1）
  // standard の 0 と対比し「standard のみ reviewer をスキップする」経路を pin する
  assert.ok(
    reviewerCalls.length >= 1,
    `SHAPE=complex: plan-reviewer は >= 1 回呼ばれるべきだが ${reviewerCalls.length} 回だった`,
  );
});

// PLAN_SOLO / plan#standard / plan#trivial / EVAL_PASSES 定数の存在および EVAL ループが
// EVAL_MAX 直書きでなく EVAL_PASSES 変数経由であることを個別に静的 pin していた section B/C
// （旧: 構造テスト・F1 cap-check テスト）は削除する（issue #636）。これらが検証したかった
// 実体（standard は plan-reviewer 0 回・evaluator ちょうど 1 回で止まる／complex は
// plan-reviewer が起動する）は、上の A. 振る舞いカウント検証で VM 実行により既に挙動として
// 保証済み（EVAL_PASSES が EVAL_MAX に固定されたままだったり cap-check が機能しなければ、
// standard の evaluatorCalls.length は 1 ではなく複数になり A のアサートが落ちる）。
// EVAL_PASSES を動的に EVAL_MAX まで引き上げる re-floor 経路の挙動は
// `_lib/refloor-shape-routing.test.mjs` の (B) が standard + realized 6 files で
// evaluator >= 2 回（full loop 化）を VM 実行で検証済み。
