// AC#1: DESIGN_REPLAN_MAX cap テスト（design-replan-cap）
// complex 経路で evaluator が毎回異なる topic の design critical を返し続けるとき
// (evalSeen の stuck 検出が発火しない = paraphrase 模倣)、
// DESIGN_REPLAN_MAX=2 で replan が打ち切られ evaluator 呼び出しが 3 回で停止することを検証する。
//
// このテストファイルは TDD red として作成された。
// F2 実装（DESIGN_REPLAN_MAX cap 機構）完了後に green になる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（eval-convergence.test.mjs の makeSandbox / runDevFlowCapture をベースに拡張）----

/**
 * design-replan-cap 専用の VM sandbox を組む。
 * evaluator stub は呼び出し回数 callIndex に応じて毎回異なる topic を生成する（paraphrase 模倣）。
 * dev-planner stub は replan#N ラベルの呼び出しを replanCalls に記録する。
 * log stub は全ログを logs 配列に捕捉する。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @returns {{ ctx: vm.Context, counters: { evaluatorCalls: () => number, replanCalls: () => object[], logs: () => string[] } }}
 */
function makeSandbox(analyzeReq) {
  const evalCalls = [];
  const replanCallsList = [];
  const logMessages = [];

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
      // replan#N ラベル（Evaluate phase の design replan）だけを replanCalls に記録する
      // plan#... や replan-blocked#N は混入させない
      if (/^replan#\d+$/.test(label)) {
        replanCallsList.push({ label, opts });
      }
      return { summary: 'p', serial: [], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を絞る
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub が呼び出し回数を記録し、callIndex に応じた異なる topic を生成する
    if (agentType === 'evaluator') {
      const callIndex = evalCalls.length;
      evalCalls.push({ label, agentType, callIndex });
      // 毎回異なる topic を生成（paraphrase 模倣 = evalSeen の stuck 検出が発火しない）
      return {
        verdict: 'fail',
        total: 5,
        threshold: 7,
        feedback: [
          {
            severity: 'critical',
            topic: `design-flaw-paraphrase-${callIndex}`,
            description: `設計欠陥の言い換え${callIndex}`,
            suggestion: '再設計せよ',
          },
        ],
        feedback_level: 'design',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
      };
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    // realized-diff（Security floor）: dev-runner-haiku, label='realized-diff', CHANGED schema
    if (agentType === 'dev-runner-haiku' && label === 'realized-diff') {
      return { files: ['src/foo.ts'] };
    }
    // declared-path-check（Validate）: dev-runner-haiku, label='declared-path-check', CHANGED schema
    if (agentType === 'dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['src/foo.ts'] };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外。HOLD 要因を絞る）
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
    log: (msg) => logMessages.push(String(msg)),
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（eval-convergence.test.mjs と同一セット）
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
    counters: {
      evaluatorCalls: () => evalCalls.length,
      replanCalls: () => replanCallsList,
      logs: () => logMessages,
    },
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * eval-convergence.test.mjs の runDevFlowCapture と同型。
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

test('[design-replan-cap] AC#1-5: paraphrase design critical 連発 → DESIGN_REPLAN_MAX=2 で cap', async () => {
  // complex に落ちる req（count=7 → floor=complex → EVAL_PASSES=EVAL_MAX=10 のループ経路）
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 7,
    shape: 'complex',
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(analyzeReq);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const replanCalls = counters.replanCalls();
  const evaluatorCalls = counters.evaluatorCalls();
  const logs = counters.logs();

  // AC#1: replanCalls.length === 2
  // dev-planner の Evaluate replan が DESIGN_REPLAN_MAX=2 回で停止し、それ以上呼ばれない
  assert.equal(
    replanCalls.length,
    2,
    `replan は DESIGN_REPLAN_MAX=2 回で停止すべきだが ${replanCalls.length} 回呼ばれた`
    + ` (labels: ${replanCalls.map((r) => r.label).join(', ')})`,
  );

  // AC#2: evaluatorCalls === 3
  // eval#1→replan#1→eval#2→replan#2→eval#3 で cap break
  // DESIGN_REPLAN_MAX + 1 回の evaluator 呼び出し。EVAL_MAX=10 まで回らない
  assert.equal(
    evaluatorCalls,
    3,
    `evaluator は DESIGN_REPLAN_MAX+1=3 回で停止すべきだが ${evaluatorCalls} 回呼ばれた`,
  );

  // AC#3（issue AC#2）: result?.merge_tier === 'HOLD'
  // 未解消 critical が ledger に残り未収束のため
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `未解消 critical で収束しないため merge_tier は 'HOLD' であるべきだが '${result?.merge_tier}' だった`,
  );

  // AC#4: result?.design_replan_count === 2
  assert.equal(
    result?.design_replan_count,
    2,
    `design_replan_count は 2 であるべきだが ${result?.design_replan_count} だった`,
  );

  // AC#5: ログに 'design replan 上限到達 — human review へ委譲' を含む行がある
  assert.ok(
    logs.some((m) => m.includes('design replan 上限到達 — human review へ委譲')),
    `ログに 'design replan 上限到達 — human review へ委譲' が含まれるべきだが見つからなかった。`
    + ` ログ全文:\n${logs.join('\n')}`,
  );
});
