// 負の制御群テスト（green-fix 0 回経路）。
// green-fix が一度も発生しない run では evaluator prompt に「テスト弱体化」focus が
// 注入されないことを pin する。このテストは F3 実装前から green で正しい（F1 が red を担う）。
// F3 実装後も引き続き green であること（誤って負の制御群に focus が混入しないことを保証する）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox をコピー）----
// calls には prompt も記録: calls.push({ label, agentType, prompt })

/**
 * green-fix なし経路専用の VM sandbox を組む。
 * agent() を呼び出しカウンタ stub にし、calls 配列を expose する。
 * test runner（label startsWith 'test'）は常に passed (green:true) を返すため
 * green-fix 経路に入らない。
 *
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox() {
  const calls = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: prompt ?? '' });

    // Setup(worktree)
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
      return { hits: [] };
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

// ============================================================
// 共有実行（複数テストが同じ sandbox 実行結果を参照するため）
// ============================================================

let sharedCalls = null;
let sharedErr = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox();
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
  const withAuditFocus = evaluatorCalls.filter((c) => c.prompt.includes('テスト弱体化'));
  assert.equal(
    withAuditFocus.length,
    0,
    `green-fix 0 回経路: evaluator の prompt に「テスト弱体化」が含まれてはいけないが`
      + ` ${withAuditFocus.length} 件含まれていた`
      + `\n最初の該当 prompt (先頭300文字):\n${withAuditFocus[0]?.prompt.slice(0, 300) ?? ''}`,
  );
});
