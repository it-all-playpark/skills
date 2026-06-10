// AC#1/AC#2: ESCALATE-TO-HUMAN producer 実経路テスト（issue #177）
//
// このテストファイルは TDD red として作成された。
// F2 実装（eval loop の escalate 転写 + EVAL schema 拡張）完了後に green になる。
//
// テスト 1（AC#1）: evaluator が escalate:true の major feedback を返す
//   → merge_tier === 'HOLD' かつ merge_tier_reasons に 'ESCALATE-TO-HUMAN 項目 1 件' を含む。
// テスト 2（AC#2）: 同条件で escalate キーなしの major feedback のみ
//   → merge_tier === 'REVIEW'（HOLD にならない = 従来挙動）。
// テスト 3: テスト 1 と同じ sandbox で post-summary prompt に 'ESCALATE-TO-HUMAN' を含む。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（merge-tier-unsatisfied-ac.test.mjs の makeSandbox / runDevFlowCapture をベースに拡張）----

/**
 * escalate-producer 検証専用の VM sandbox を組む。
 * evaluator stub が引数 evaluatorResponse を返すように改変。
 * post-summary の prompt を capture するために agentStub を拡張している。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス
 * @returns {{ ctx: vm.Context, getCapturedPostSummaryPrompt: () => string|null }}
 */
function makeSandbox(analyzeReq, evaluatorResponse) {
  let capturedPostSummaryPrompt = null;

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
    // → danger clean にして HOLD 要因を escalate のみに絞る
    if (label.startsWith('danger-grep')) {
      return { hits: [] };
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
    // → docs/test-only でないファイルを返す（AUTO 除外。HOLD 要因を escalate のみに絞る）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary: prompt を capture して投稿成功を返す
    if (label === 'post-summary') {
      capturedPostSummaryPrompt = prompt;
      return { posted: true, method: 'gh pr comment', url: 'http://x/1' };
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

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'LGTM' });

  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（merge-tier-unsatisfied-ac.test.mjs と同一セット）
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
  return {
    ctx,
    getCapturedPostSummaryPrompt: () => capturedPostSummaryPrompt,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * merge-tier-unsatisfied-ac.test.mjs の runDevFlowCapture と同型。
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

// standard に落ちる analyzeReq（count=3, ac=1件, type='feat' → floor='standard'）
// AC は 1 件以上必須（dev-flow.js L793 付近で acceptance_criteria を ledger に積む）
const standardAnalyzeReq = {
  summary: 'add naming convention for api',
  acceptance_criteria: ['API naming convention is enforced'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

// ============================================================
// テスト 1（AC#1）: escalate:true の major → merge_tier === 'HOLD'
// ============================================================
test('[escalate-producer] AC#1: escalate:true の major feedback → merge_tier === HOLD', async () => {
  const evaluatorResponse = {
    verdict: 'pass',
    total: 8,
    threshold: 7,
    feedback: [
      {
        severity: 'major',
        topic: 'naming preference in api',
        description: 'd',
        suggestion: 's',
        escalate: true,
        escalate_reason: 'preference',
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e', verified_by: 'inspection' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(standardAnalyzeReq, evaluatorResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // merge_tier が HOLD であることを assert
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `escalate:true の major feedback がある場合、merge_tier は 'HOLD' であるべきだが '${result?.merge_tier}' だった`,
  );

  // merge_tier_reasons に 'ESCALATE-TO-HUMAN 項目 1 件' が含まれることを assert
  assert.ok(
    Array.isArray(result?.merge_tier_reasons)
      && result.merge_tier_reasons.some((x) => /ESCALATE-TO-HUMAN 項目 1 件/.test(x)),
    `merge_tier_reasons に 'ESCALATE-TO-HUMAN 項目 1 件' が含まれるべきだが含まれなかった: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// テスト 2（AC#2）: escalate なしの major → merge_tier === 'REVIEW'（従来挙動）
// ============================================================
test('[escalate-producer] AC#2: escalate なしの major feedback → merge_tier === REVIEW（従来挙動）', async () => {
  const evaluatorResponse = {
    verdict: 'pass',
    total: 8,
    threshold: 7,
    feedback: [
      {
        severity: 'major',
        topic: 'naming preference in api',
        description: 'd',
        suggestion: 's',
        // escalate キーなし（省略 = false 扱い）
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e', verified_by: 'inspection' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(standardAnalyzeReq, evaluatorResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // escalate なし major は advisory lane のみ → HOLD にならない
  assert.equal(
    result?.merge_tier,
    'REVIEW',
    `escalate なしの major feedback の場合、merge_tier は 'REVIEW' であるべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// テスト 3: post-summary prompt が 'ESCALATE-TO-HUMAN' を含む（終端サマリー実経路確認）
// ============================================================
test('[escalate-producer] テスト3: escalate:true の major → post-summary prompt に ESCALATE-TO-HUMAN を含む', async () => {
  const evaluatorResponse = {
    verdict: 'pass',
    total: 8,
    threshold: 7,
    feedback: [
      {
        severity: 'major',
        topic: 'naming preference in api',
        description: 'd',
        suggestion: 's',
        escalate: true,
        escalate_reason: 'preference',
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e', verified_by: 'inspection' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, getCapturedPostSummaryPrompt } = makeSandbox(standardAnalyzeReq, evaluatorResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const capturedPrompt = getCapturedPostSummaryPrompt();

  // post-summary が呼ばれたことを確認
  assert.ok(
    capturedPrompt !== null,
    'post-summary agent が呼ばれなかった（prompt が capture されなかった）',
  );

  // post-summary の prompt が 'ESCALATE-TO-HUMAN' を含むことを assert（buildDevflowSummaryBody 経由）
  assert.ok(
    capturedPrompt.includes('ESCALATE-TO-HUMAN'),
    `post-summary の prompt に 'ESCALATE-TO-HUMAN' が含まれるべきだが含まれなかった。\ncaptured: ${capturedPrompt?.slice(0, 500)}`,
  );
});
