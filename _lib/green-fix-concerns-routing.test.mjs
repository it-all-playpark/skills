// TDD red として作成。F1 実装（本経路 green-fix concerns → concerns 配列 push）までは fail する。
// テスト 3（eval#1 prompt へのマーカー到達）・テスト 4（ソースの対称パターン存在）は F1 実装前の現時点で fail する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（green-fix-test-audit.test.mjs の makeCountingSandbox / runDevFlowInSandbox / ensureSharedRun の 3 点セットと同型）----

/**
 * green-fix concerns routing 専用の VM sandbox を組む。
 * agent() を呼び出しカウンタ stub にし、calls 配列を expose する。
 * test stub は 1 回目が failed (green:false)、2 回目以降は passed (green:true) を返す
 * ことで green-fix#1 が 1 回だけ走る経路を再現する。
 * 唯一の本質的差分: green-fix stub が concerns マーカーを返す（既存テンプレートは concerns: []）。
 *
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox() {
  const calls = [];
  // test runner 呼び出し回数を追跡するクロージャカウンタ
  let testCallCount = 0;

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
    // 必ず standard（micro だと Evaluate が skip され eval#1 が発生しない）
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
    // 1 回目は failed (green:false)、2 回目以降は passed (green:true)
    if (label.startsWith('test')) {
      testCallCount += 1;
      if (testCallCount === 1) {
        return { tests: 'failed', green: false, summary: 'assert mismatch' };
      }
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
    // diff-gate / diff-hash（issue #215）: empty:false で retry 経路に入らない（本経路のみを検証）
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    // implementer（green-fix も含む）
    // 【唯一の本質的差分】green-fix stub が concerns マーカーを返す
    if (agentType === 'implementer' && label.startsWith('green-fix')) {
      return {
        status: 'DONE',
        task_id: 't',
        files: [],
        summary: '',
        concerns: ['GREEN_FIX_CONCERN_MARKER: retry ロジックに未検証の race が残る'],
      };
    }
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
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（green-fix-test-audit.test.mjs と同一セット）
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
 * green-fix-test-audit.test.mjs の runDevFlowInSandbox と同型。
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
// 共有実行（4 テストが同じ sandbox 実行結果を参照するため）
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
// テスト 1: crash guard（green-fix-test-audit.test.mjs と同じパターン）
// ============================================================

test('[green-fix-concerns] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedErr && (sharedErr.name === 'ReferenceError' || sharedErr.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedErr.name}: ${sharedErr.message}`);
  }
});

// ============================================================
// テスト 2: sanity — green-fix call が 1 回以上発生していること
// ============================================================

test('[green-fix-concerns] sanity: green-fix call が 1 回以上発生すること', async () => {
  await ensureSharedRun();
  const greenFixCalls = sharedCalls.filter((c) => c.label.startsWith('green-fix'));
  assert.ok(
    greenFixCalls.length >= 1,
    `green-fix label の call が 1 回以上発生すべきだが ${greenFixCalls.length} 回だった`
      + ` (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
});

// ============================================================
// テスト 3（本命・AC#3）: eval#1 の prompt に GREEN_FIX_CONCERN_MARKER が含まれること
// 本経路 green-fix concerns → evaluator focus_areas 到達の pin
// ============================================================

test('[green-fix-concerns] AC#3: eval#1 の prompt に GREEN_FIX_CONCERN_MARKER が含まれること（本経路 green-fix concerns → evaluator focus_areas 到達）', async () => {
  await ensureSharedRun();
  const eval1 = sharedCalls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('GREEN_FIX_CONCERN_MARKER'),
    `eval#1 の prompt に 'GREEN_FIX_CONCERN_MARKER' が含まれていない。\nprompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`,
  );
});

// ============================================================
// テスト 4（構造テスト・AC#2）: dev-flow.js ソースに対称パターンが含まれること
// retry 経路 L1586 の `gfRetry` パターンとの対称性 pin
// ============================================================

test('[green-fix-concerns][struct] AC#2: dev-flow.js ソースに対称パターン「if (gfResult && Array.isArray(gfResult.concerns)) concerns.push(...gfResult.concerns)」が含まれること', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes('if (gfResult && Array.isArray(gfResult.concerns)) concerns.push(...gfResult.concerns)'),
    'dev-flow.js に「if (gfResult && Array.isArray(gfResult.concerns)) concerns.push(...gfResult.concerns)」が存在すること（retry 経路 gfRetry パターンとの対称性）',
  );
});
