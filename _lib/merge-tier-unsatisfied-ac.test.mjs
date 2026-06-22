// AC#4: VM カウントテスト（shape-loop-routing.test.mjs と同型）
// standard 経路で evaluator stub が satisfied:false を返すと merge_tier === 'HOLD' になることを検証する。
//
// このテストファイルは TDD red として作成された。
// F3 実装（AC 未達時に unsatisfiedAc フラグを立て classifyMergeTier に渡す）完了後に green になる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox と同型）----

/**
 * AC 未達検証専用の VM sandbox を組む。
 * evaluator stub が引数 evaluatorResponse を返すように改変。
 * resolved 値（return object）を捕捉できるよう runner も改変している。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス
 * @returns {{ ctx: vm.Context }}
 */
function makeSandbox(analyzeReq, evaluatorResponse) {
  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Setup(worktree)
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan: dev-planner (plan#trivial / plan#standard / plan#N / replan 系)
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を AC のみに絞る
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub が引数 evaluatorResponse を返す
    if (agentType === 'evaluator') {
      return evaluatorResponse;
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外。HOLD 要因を AC のみに絞る）
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

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（shape-loop-routing.test.mjs と同一セット）
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
  return { ctx };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * shape-loop-routing.test.mjs の runDevFlowInSandbox と異なり、
 * IIFE の **resolved 値（return object）を捕捉して返す**。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ result: object|null, error: Error|null }>}
 */
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

// ============================================================
// テストケース
// ============================================================

test('[unsatisfied-ac] standard 経路: evaluator が satisfied:false → merge_tier === HOLD', async () => {
  // standard に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）
  // AC は最低1件必須（dev-flow.js L793 で acceptance_criteria を ledger に積む）
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  // evaluatorResponse: AC#1（ac_index:0）を satisfied:false にする。
  // verified_by を 'inspection'（test 以外）にして redgreen-verify 分岐を回避し、
  // L880 の `else if (r.satisfied)` 経路に入る（satisfied:false → checkItem されず blocking のまま残る）。
  const evaluatorResponse = {
    verdict: 'pass',
    total: 100,
    threshold: 80,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: false, verified_by: 'inspection', evidence: '未達' },
    ],
    security_clearance: [],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(analyzeReq, evaluatorResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // merge_tier が HOLD であることを assert
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `standard 経路で evaluator が satisfied:false を返した場合、merge_tier は 'HOLD' であるべきだが '${result?.merge_tier}' だった`,
  );

  // merge_tier_reasons に AC 未達が含まれることを assert（挙動 pin）
  assert.ok(
    Array.isArray(result?.merge_tier_reasons) && result.merge_tier_reasons.some((x) => /AC 未達/.test(x)),
    `merge_tier_reasons に 'AC 未達' が含まれるべきだが含まれなかった: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

test('[unsatisfied-ac] standard 経路: 全 AC satisfied:true → merge_tier \!== HOLD（回帰防止・挙動不変）', async () => {
  // 同じ analyzeReq（standard 落ち）
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  // evaluatorResponse: 全 AC に対し satisfied:true。AC 未達フラグが false の時に不要な HOLD を出さないことを pin。
  // verified_by:'inspection' で redgreen-verify 分岐を回避し L883 の `else if (r.satisfied)` → checkItem 経路に入る。
  const evaluatorResponse = {
    verdict: 'pass',
    total: 100,
    threshold: 80,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
      { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
      { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
      { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    ],
    security_clearance: [],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(analyzeReq, evaluatorResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // 全 AC satisfied:true + danger clean + docsOrTestOnly でない standard → REVIEW を期待
  assert.equal(
    result?.merge_tier,
    'REVIEW',
    `全 AC satisfied:true の場合、merge_tier は 'REVIEW' であるべきだが '${result?.merge_tier}' だった`,
  );
});
