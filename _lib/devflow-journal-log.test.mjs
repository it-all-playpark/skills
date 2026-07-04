// AC#1 / AC#3 (F2): journal-log VM カウントテスト（issue #203: handoff 方式）
// Merge tier phase 末尾に journal-log dev-runner-haiku 呼び出しが 1 回発生すること、
// prompt が telemetry handoff JSON を pending dir へ書き出す方式（CLI フラグ方式ではない）であること、
// および logged:false stub でも workflow が正常 return することを検証する。
//
// handoff 方式: JS 側で JSON.stringify した telemetry を
// ~/.claude/journal/pending/devflow-<issue>-<ts>.json へ書き出す。
// dotfiles の Stop hook (stop-devflow-telemetry.sh) が journal.sh log へ flush する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（devflow-summary-post.test.mjs の makeSandbox / runDevFlowCapture と同型）----

/**
 * journal-log 呼び出し検証専用の VM sandbox を組む。
 * agentStub は opts.label / opts.agentType を見て phase 別に最小スキーマを返す。
 * journal-log stub の戻り値は引数 journalResult で切り替え可能。
 * resolved 値（return object）を捕捉できるよう runner も同型にしている。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} journalResult - journal-log stub が返すレスポンス（ログ成功/失敗を切り替え）
 * @returns {{ ctx: vm.Context, getJournalCallCount: () => number, getJournalPrompts: () => string[] }}
 */
function makeSandbox(analyzeReq, journalResult) {
  // journal-log 呼び出しカウンタ
  let journalCallCount = 0;
  const journalPrompts = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

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
    // → danger clean にして HOLD 要因を発生させない
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub（最小 pass レスポンス）
    if (agentType === 'evaluator') {
      return {
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
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary: posted:true 固定
    if (label === 'post-summary' && agentType === 'dev-runner') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-log: 呼び出しカウンタをインクリメントし journalResult を返す
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      journalCallCount += 1;
      journalPrompts.push(prompt);
      return journalResult;
    }
    // implementer その他
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // デフォルト: 未知の label は null を返す（journal-log が need() で包まれないことを前提）
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  // sandbox object（devflow-summary-post.test.mjs と同一セット）
  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（devflow-summary-post.test.mjs と同一セット）
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
    getJournalCallCount: () => journalCallCount,
    getJournalPrompts: () => journalPrompts,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * devflow-summary-post.test.mjs の runDevFlowCapture と同型：
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

// standard 経路に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）
// Merge tier phase まで到達させる
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

const src = readFileSync(devFlowPath, 'utf8');

test('[journal-log] AC#1: Merge tier phase 後に journal-log dev-runner-haiku 呼び出しが 1 回発生し、prompt に handoff JSON キーと pending パスが含まれること', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalCallCount, getJournalPrompts } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // journal-log 呼び出しカウント === 1
  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );

  // 捕捉した prompt に handoff JSON の必須キーと pending パスが含まれること
  const capturedPrompt = getJournalPrompts()[0] ?? '';
  const requiredKeys = [
    '.claude/journal/pending/',
    '"merge_tier"',
    '"gate_policy"',
    '"danger_hits"',
    '"danger_fail_closed"',
    '"shape"',
    '"shape_refloored"',
    '"plan_iter"',
    '"eval_iter"',
    '"skill":"dev-flow"',
    '"outcome":"success"',
    '"journal_sh"',
  ];
  for (const key of requiredKeys) {
    assert.ok(
      capturedPrompt.includes(key),
      `journal-log prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
    );
  }
});

test('[journal-log] AC#3: journal-log stub が logged:false を返しても result.merge_tier が正常 return されること', async () => {
  // ログ失敗をシミュレート: logged:false（「記録失敗でも workflow return 成功」仕様の回帰検出）
  const journalResult = { logged: false, summary: 'failed' };
  const { ctx } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // result が null でなく、throw されていない
  assert.ok(
    result !== null && result !== undefined,
    `ログ失敗（logged:false）でも workflow は return object を解決するべきだが null/undefined だった`,
  );

  // result.merge_tier が文字列（'HOLD'|'REVIEW'|'AUTO' のいずれか）として返ること
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `ログ失敗でも result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );
});
