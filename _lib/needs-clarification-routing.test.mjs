// needs_clarification ルーティングの振る舞いを VM sandbox で pin するテスト（TDD red として作成）。
// F1 時点では dev-flow.js に needs_clarification / ambiguities が未実装のため、
// T1/T2/T5 のカウント assert・return 値 assert および T6 の構造 assert が fail する（= 赤）。
// T3/T4 は現行挙動の pin（pass）。
//
// shape-loop-routing.test.mjs の構造を踏襲:
//   - node:test + node:assert/strict + node:vm
//   - dev-flow.js ソースを readFileSync で読み export const を strip して async IIFE でラップし vm.runInContext で実行
//
// 主な拡張:
//   (a) agent stub の calls 配列に {label, agentType, prompt} を記録する（prompt 文字列の検証に使う）
//   (b) run helper は IIFE の resolve 値（workflow の return object）を {error, result} で返す

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

/**
 * needs-clarification-routing 専用の VM sandbox を組む。
 * shape-loop-routing.test.mjs の makeCountingSandbox と同型だが以下の拡張を加える:
 *   (a) calls 配列に {label, agentType, prompt} を記録する（prompt 検証のため）
 *   (b) agentType==='implementer' の分岐は implementerFn(callIndex) 関数で注入する
 *   (c) workflow() stub は呼ばれたら workflowCalled フラグを立て {status:'LGTM'} を返す
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {function} implementerFn - (callIndex: number) => object。implementer stub の戻り値を決定する。
 *   callIndex は implementer が呼ばれた通算回数（0 ベース）。
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}>, workflowCalledRef: {called: boolean} }}
 */
function makeCountingSandbox(analyzeReq, implementerFn) {
  const calls = [];
  let implementerCallIndex = 0;
  const workflowCalledRef = { called: false };

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: prompt ?? '' });

    // Setup(worktree)
    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる（初回分析と再分析の両方）
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan: dev-planner（plan#trivial / plan#standard / plan#N / replan 系）
    // implementer を起動させるため serial 1 件を必ず返す
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 'T1', desc: 'task' }], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
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
    // Merge tier / Validate: changed-files, realized-diff, declared-path-check
    if (label === 'changed-files' || label === 'realized-diff' || label === 'declared-path-check') {
      return { files: [] };
    }
    // Implementer: 注入した implementerFn(callIndex) を使う
    if (agentType === 'implementer') {
      const result = implementerFn(implementerCallIndex);
      implementerCallIndex++;
      return result;
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // デフォルト
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // workflow() stub: 呼ばれたら flag を立てて {status:'LGTM'} を返す
  const workflowStub = async () => {
    workflowCalledRef.called = true;
    return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
  };

  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
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
  return { ctx, calls, workflowCalledRef };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * refloor-shape-routing.test.mjs の runDevFlowInSandbox と同型:
 *   vm.runInContext の戻り値（workflow の return object）を解決して {error, result} で返す。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ error: Error|null, result: object|null }>}
 *   error: クラッシュがあれば Error、無ければ null
 *   result: workflow の return object（正常完了時）、エラー時は null
 */
async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let result = null;
  try {
    const promise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (promise && typeof promise.then === 'function') {
      result = await promise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, result };
}

// ---- standard 形状の req 雛形 ----
const standardReq = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

// ============================================================
// T1: implementer が常に NEEDS_CONTEXT を返す
// → analyze 系 2 回・うち 1 回は '--depth comprehensive' を含む
// → pr 系 0 回・workflow 未呼び出し
// → result.status === 'needs_clarification'
// → result.missing_context は非空 Array
// → result.worktree === '/tmp/wt'
// → 全 calls の prompt に 'worktree remove' を含まない
//
// T1 は TDD red: 現行 dev-flow.js は needs_clarification を返さないため fail。
// ============================================================
test('[needs-clarification] T1: 常に NEEDS_CONTEXT → 再分析+needs_clarification を返し PR を起動しない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls, workflowCalledRef } = makeCountingSandbox(
    standardReq,
    () => ({
      status: 'NEEDS_CONTEXT',
      task_id: 'T1',
      files: [],
      summary: '',
      concerns: [],
      blocking_reason: null,
      missing_context: 'API 仕様が不明',
    }),
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // analyze 系呼び出しがちょうど 2 回
  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze'));
  assert.equal(
    analyzeCalls.length,
    2,
    `T1: analyze 系呼び出しは 2 回のはずだが ${analyzeCalls.length} 回だった (labels: ${analyzeCalls.map((c) => c.label).join(', ')})`,
  );

  // うちちょうど 1 回の prompt に '--depth comprehensive' を含む
  const comprehensiveCount = analyzeCalls.filter((c) => c.prompt.includes('--depth comprehensive')).length;
  assert.equal(
    comprehensiveCount,
    1,
    `T1: '--depth comprehensive' を含む analyze 呼び出しはちょうど 1 回のはずだが ${comprehensiveCount} 回だった`,
  );

  // label 'pr' 始まりの呼び出し 0 回
  const prCalls = calls.filter((c) => c.label.startsWith('pr'));
  assert.equal(
    prCalls.length,
    0,
    `T1: label 'pr' 始まりの呼び出しは 0 回のはずだが ${prCalls.length} 回だった`,
  );

  // workflow() 未呼び出し
  assert.equal(
    workflowCalledRef.called,
    false,
    'T1: workflow() は呼ばれないはずだが呼ばれた',
  );

  // result.status === 'needs_clarification'
  assert.equal(
    result?.status,
    'needs_clarification',
    `T1: result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`,
  );

  // result.missing_context は非空 Array
  assert.ok(
    Array.isArray(result?.missing_context) && result.missing_context.length > 0,
    `T1: result.missing_context は非空 Array のはずだが ${JSON.stringify(result?.missing_context)} だった`,
  );

  // result.worktree === '/tmp/wt'
  assert.equal(
    result?.worktree,
    '/tmp/wt',
    `T1: result.worktree は '/tmp/wt' のはずだが ${JSON.stringify(result?.worktree)} だった`,
  );

  // 全 calls の prompt に 'worktree remove' を含まない
  const worktreeRemoveCalls = calls.filter((c) => c.prompt.includes('worktree remove'));
  assert.equal(
    worktreeRemoveCalls.length,
    0,
    `T1: 'worktree remove' を含む呼び出しは 0 件のはずだが ${worktreeRemoveCalls.length} 件あった`,
  );
});

// ============================================================
// T2: analyzeReq を micro 形状にする
// → dev-planner 0 回・result.status === 'needs_clarification'
// → missing_context 非空・pr 系 0 回
//
// T2 は TDD red: 現行 dev-flow.js は needs_clarification を返さないため fail。
// ============================================================
test('[needs-clarification] T2: micro 形状 + NEEDS_CONTEXT → dev-planner 0 回・needs_clarification', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: [],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
  };
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(
    microReq,
    () => ({
      status: 'NEEDS_CONTEXT',
      task_id: 'T1',
      files: [],
      summary: '',
      concerns: [],
      blocking_reason: null,
      missing_context: 'API 仕様が不明',
    }),
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // agentType==='dev-planner' の呼び出し 0 回
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-planner');
  assert.equal(
    plannerCalls.length,
    0,
    `T2: dev-planner 呼び出しは 0 回のはずだが ${plannerCalls.length} 回だった`,
  );

  // result.status === 'needs_clarification'
  assert.equal(
    result?.status,
    'needs_clarification',
    `T2: result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`,
  );

  // missing_context 非空
  const mc = result?.missing_context;
  const nonEmpty = (mc != null) && (
    (typeof mc === 'string' && mc.length > 0)
    || (Array.isArray(mc) && mc.length > 0)
  );
  assert.ok(
    nonEmpty,
    `T2: result.missing_context は非空のはずだが ${JSON.stringify(mc)} だった`,
  );

  // label 'pr' 始まり 0 回
  const prCalls = calls.filter((c) => c.label.startsWith('pr'));
  assert.equal(
    prCalls.length,
    0,
    `T2: label 'pr' 始まりの呼び出しは 0 回のはずだが ${prCalls.length} 回だった`,
  );
});

// ============================================================
// T3: 正常 path 制御群（implementer が常に DONE）
// → analyze 系ちょうど 1 回・dev-planner 1 回・evaluator 1 回・pr 1 回
// → workflow() 呼び出し済み・result.pr_url 存在・result.status undefined
//
// T3 は現行挙動の pin（pass）。
// ============================================================
test('[needs-clarification] T3: 正常 path（DONE）→ analyze/planner/evaluator/pr 各 1 回・PR 完走', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls, workflowCalledRef } = makeCountingSandbox(
    standardReq,
    () => ({
      status: 'DONE',
      task_id: 'T1',
      files: [],
      summary: '',
      concerns: [],
      blocking_reason: null,
      missing_context: null,
    }),
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // analyze 系ちょうど 1 回
  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze'));
  assert.equal(
    analyzeCalls.length,
    1,
    `T3: analyze 系呼び出しは 1 回のはずだが ${analyzeCalls.length} 回だった`,
  );

  // dev-planner ちょうど 1 回（standard 経路なので plan#standard の 1 回のみ）
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-planner');
  assert.equal(
    plannerCalls.length,
    1,
    `T3: dev-planner 呼び出しは 1 回のはずだが ${plannerCalls.length} 回だった`,
  );

  // evaluator ちょうど 1 回
  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.equal(
    evaluatorCalls.length,
    1,
    `T3: evaluator 呼び出しは 1 回のはずだが ${evaluatorCalls.length} 回だった`,
  );

  // pr 系ちょうど 1 回
  const prCalls = calls.filter((c) => c.label.startsWith('pr'));
  assert.equal(
    prCalls.length,
    1,
    `T3: label 'pr' 始まりの呼び出しは 1 回のはずだが ${prCalls.length} 回だった`,
  );

  // workflow() 呼び出し済み
  assert.equal(
    workflowCalledRef.called,
    true,
    'T3: workflow() は呼ばれるはずだが呼ばれなかった',
  );

  // result.pr_url 存在
  assert.ok(
    result?.pr_url != null,
    `T3: result.pr_url が存在するはずだが ${JSON.stringify(result?.pr_url)} だった`,
  );

  // result.status は undefined（通常の return object に status フィールドは無い）
  assert.equal(
    result?.status,
    undefined,
    `T3: result.status は undefined のはずだが ${JSON.stringify(result?.status)} だった`,
  );
});

// ============================================================
// T4: BLOCKED path 不変（implementer が常に BLOCKED）
// → analyze 系 1 回（NEEDS_CONTEXT 用再分析が走らない）
// → dev-planner 呼び出し 1+BLOCK_MAX(=2)=3 回（初回 plan + replan-blocked 2 回）
// → label 'pr' 始まり 1 回（BLOCKED は従来通り PR まで進む）
//
// T4 は現行挙動の pin（pass）。
// ============================================================
test('[needs-clarification] T4: BLOCKED path 不変 → analyze 1 回・dev-planner 3 回・pr 1 回', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(
    standardReq,
    () => ({
      status: 'BLOCKED',
      task_id: 'T1',
      blocking_reason: 'no way',
      files: [],
      summary: '',
      concerns: [],
      missing_context: null,
    }),
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // analyze 系 1 回（NEEDS_CONTEXT 用の再分析は走らない）
  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze'));
  assert.equal(
    analyzeCalls.length,
    1,
    `T4: analyze 系は NEEDS_CONTEXT 再分析なしで 1 回のはずだが ${analyzeCalls.length} 回だった`,
  );

  // dev-planner 3 回（初回 plan#standard + replan-blocked#1 + replan-blocked#2）
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-planner');
  assert.equal(
    plannerCalls.length,
    3,
    `T4: dev-planner は 1+BLOCK_MAX=3 回のはずだが ${plannerCalls.length} 回だった (labels: ${plannerCalls.map((c) => c.label).join(', ')})`,
  );

  // label 'pr' 始まり 1 回（BLOCKED でも PR まで進む）
  const prCalls = calls.filter((c) => c.label.startsWith('pr'));
  assert.equal(
    prCalls.length,
    1,
    `T4: label 'pr' 始まりは 1 回のはずだが ${prCalls.length} 回だった`,
  );
});

// ============================================================
// T5: 回復 path（1 回目 NEEDS_CONTEXT・2 回目以降 DONE）
// → analyze 系 2 回・label 'pr' 始まり 1 回・result.pr_url 存在
// （再分析+再試行で回復し PR まで完走）
//
// T5 は TDD red: 現行 dev-flow.js は needs_clarification ルーティングを持たないため fail。
// ============================================================
test('[needs-clarification] T5: 回復 path（1 回目 NEEDS_CONTEXT → 2 回目 DONE）→ analyze 2 回・PR 完走', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls, workflowCalledRef } = makeCountingSandbox(
    standardReq,
    (callIndex) => {
      if (callIndex === 0) {
        return {
          status: 'NEEDS_CONTEXT',
          task_id: 'T1',
          files: [],
          summary: '',
          concerns: [],
          blocking_reason: null,
          missing_context: 'API 仕様が不明',
        };
      }
      return {
        status: 'DONE',
        task_id: 'T1',
        files: [],
        summary: '',
        concerns: [],
        blocking_reason: null,
        missing_context: null,
      };
    },
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // analyze 系 2 回（初回分析 + NEEDS_CONTEXT による再分析）
  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze'));
  assert.equal(
    analyzeCalls.length,
    2,
    `T5: analyze 系は 2 回のはずだが ${analyzeCalls.length} 回だった (labels: ${analyzeCalls.map((c) => c.label).join(', ')})`,
  );

  // label 'pr' 始まり 1 回
  const prCalls = calls.filter((c) => c.label.startsWith('pr'));
  assert.equal(
    prCalls.length,
    1,
    `T5: label 'pr' 始まりは 1 回のはずだが ${prCalls.length} 回だった`,
  );

  // result.pr_url 存在（PR まで完走）
  assert.ok(
    result?.pr_url != null,
    `T5: result.pr_url が存在するはずだが ${JSON.stringify(result?.pr_url)} だった`,
  );
});

// ============================================================
// T6: [struct] dev-flow.js ソースに 'ambiguities' 文字列と 'needs_clarification' 文字列が存在する
//
// T6 は TDD red: 現行 dev-flow.js にはこれらの文字列が存在しないため fail。
// ============================================================
test('[needs-clarification][struct] dev-flow.js に ambiguities と needs_clarification が存在する', () => {
  const src = readFileSync(devFlowPath, 'utf8');

  assert.ok(
    src.includes('ambiguities'),
    "dev-flow.js に 'ambiguities' 文字列が存在すること",
  );

  assert.ok(
    src.includes('needs_clarification'),
    "dev-flow.js に 'needs_clarification' 文字列が存在すること",
  );
});

// ============================================================
// T7: ambiguities 3 件 + AC 非空 → needs_clarification + missing_context が ambiguities と一致 + dev-planner 0 回
//
// レビュー指摘 (a) のケース: ambiguities.length > AMBIGUITY_MAX (3 > 2) かつ AC 非空
// → missing_context 選択 ternary の ambiguities 側（row 900 の else 分岐）が通ることを確認
// ============================================================
test('[needs-clarification] T7: ambiguities 3件 + AC 非空 → needs_clarification + missing_context===ambiguities + dev-planner 0回', async () => {
  const reqWithAmbiguities = {
    summary: 's',
    acceptance_criteria: ['ac1'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    ambiguities: ['a', 'b', 'c'],
  };
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(
    reqWithAmbiguities,
    () => ({
      status: 'DONE',
      task_id: 'T1',
      files: [],
      summary: '',
      concerns: [],
      blocking_reason: null,
      missing_context: null,
    }),
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // result.status === 'needs_clarification'
  assert.equal(
    result?.status,
    'needs_clarification',
    `T7: result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`,
  );

  // missing_context が ambiguities と一致（AC 非空なので ternary の else 側 = ambiguities）
  assert.deepEqual(
    result?.missing_context,
    ['a', 'b', 'c'],
    `T7: result.missing_context は ambiguities ['a','b','c'] のはずだが ${JSON.stringify(result?.missing_context)} だった`,
  );

  // dev-planner 0 回（曖昧ゲートで Plan 前に return）
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-planner');
  assert.equal(
    plannerCalls.length,
    0,
    `T7: dev-planner 呼び出しは 0 回のはずだが ${plannerCalls.length} 回だった`,
  );

  // label 'pr' 始まり 0 回
  const prCalls = calls.filter((c) => c.label.startsWith('pr'));
  assert.equal(
    prCalls.length,
    0,
    `T7: label 'pr' 始まりの呼び出しは 0 回のはずだが ${prCalls.length} 回だった`,
  );
});

// ============================================================
// T8: ambiguities ちょうど 2 件 → ゲート通過し Plan へ進み PR まで完走
//
// レビュー指摘 (b) の boundary ケース: ambiguities.length === AMBIGUITY_MAX (2 === 2)
// ゲート条件は > なので = は通過する。PR まで完走することを確認。
// ============================================================
test('[needs-clarification] T8: ambiguities ちょうど 2件 → ゲート通過し PR まで完走', async () => {
  const reqWithBoundaryAmbiguities = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    ambiguities: ['a', 'b'],
  };
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls, workflowCalledRef } = makeCountingSandbox(
    reqWithBoundaryAmbiguities,
    () => ({
      status: 'DONE',
      task_id: 'T1',
      files: [],
      summary: '',
      concerns: [],
      blocking_reason: null,
      missing_context: null,
    }),
  );

  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // result.status は undefined（通常完走の return object に status フィールドはない）
  assert.equal(
    result?.status,
    undefined,
    `T8: result.status は undefined（通常完走）のはずだが ${JSON.stringify(result?.status)} だった`,
  );

  // result.pr_url 存在（PR まで完走）
  assert.ok(
    result?.pr_url != null,
    `T8: result.pr_url が存在するはずだが ${JSON.stringify(result?.pr_url)} だった`,
  );

  // dev-planner 1 回（standard 経路で Plan まで進んだ）
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-planner');
  assert.equal(
    plannerCalls.length,
    1,
    `T8: dev-planner 呼び出しは 1 回のはずだが ${plannerCalls.length} 回だった`,
  );

  // workflow() 呼び出し済み（pr-iterate が起動された）
  assert.equal(
    workflowCalledRef.called,
    true,
    'T8: workflow() は呼ばれるはずだが呼ばれなかった',
  );
});

// ============================================================
// T9: [struct] analyzePrompt(depth) 関数化のピンテスト
//   (a) dev-flow.js ソースに 'analyzePrompt' 文字列が存在する（単一関数由来の構造確認）
//   (b) NEEDS_CONTEXT retry シナリオで analyze 系 2 件の prompt が
//       --depth 部分のみ異なり、depth 置換後は完全一致する
//   (c) 1 件目は '--depth comprehensive' を含まず、2 件目のみ含む
//
// T9 は TDD red: 現行 dev-flow.js に analyzePrompt 関数がないため (a) が fail。
// ============================================================
test('[needs-clarification][struct] T9: analyzePrompt(depth) 関数化 — 2 経路の prompt が depth のみ異なる', async () => {
  const src = readFileSync(devFlowPath, 'utf8');

  // (a) structural: 'analyzePrompt' 文字列が存在する
  assert.ok(
    src.includes('analyzePrompt'),
    "T9(a): dev-flow.js に 'analyzePrompt' 文字列が存在すること（analyzePrompt(depth) 関数定義）",
  );

  // (b)+(c) runtime: T1 と同じ sandbox で analyze 系 2 件を捕捉して prompt を比較
  const { ctx, calls } = makeCountingSandbox(
    standardReq,
    () => ({
      status: 'NEEDS_CONTEXT',
      task_id: 'T1',
      files: [],
      summary: '',
      concerns: [],
      blocking_reason: null,
      missing_context: 'API 仕様が不明',
    }),
  );

  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze'));
  assert.equal(
    analyzeCalls.length,
    2,
    `T9: analyze 系呼び出しは 2 回のはずだが ${analyzeCalls.length} 回だった`,
  );

  const [p0, p1] = analyzeCalls.map((c) => c.prompt);

  // depth 部分を '--depth X' に置換して比較（完全一致 = 単一関数由来）
  const normalized0 = p0.replace(/--depth \S+/, '--depth X');
  const normalized1 = p1.replace(/--depth \S+/, '--depth X');
  assert.equal(
    normalized0,
    normalized1,
    `T9(b): depth 置換後の 2 つの analyze prompt が完全一致するはずだが異なった\n  p0: ${p0.slice(0, 120)}\n  p1: ${p1.slice(0, 120)}`,
  );

  // 1 件目は '--depth comprehensive' を含まない
  assert.ok(
    !p0.includes('--depth comprehensive'),
    `T9(c): 1 件目（初回分析）の prompt は '--depth comprehensive' を含まないはずだが含んでいた`,
  );

  // 2 件目は '--depth comprehensive' を含む
  assert.ok(
    p1.includes('--depth comprehensive'),
    `T9(c): 2 件目（retry 分析）の prompt は '--depth comprehensive' を含むはずだが含まなかった`,
  );
});
