// F2 (issue #535): dev-flow 実 run（nested pr-iterate / full 経路）で iterate_rounds /
// fixes_applied が journal telemetry（journal-save prompt の handoff JSON）に載ることを検証する。
//
// workflowStub（nested workflow('pr-iterate') の代替）を非ゼロ値（iterations:3, fixes_applied:2）
// に差し替え、journal-save prompt に "iterate_rounds":3 / "fixes_applied":2 が含まれることを assert
// する。workflowStub が実際に呼ばれたこと（full 経路を通ったこと。lite 経路への逸脱検出）も併せて
// assert する。
//
// helper（makeSandbox / runDevFlowCapture / ANALYZE_REQ）は _lib/devflow-journal-log.test.mjs から
// 同型コピー（repo precedent — テストごとの helper 複製、既存テストファイルは無改変）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（_lib/devflow-journal-log.test.mjs の makeSandbox と同型。
// workflowStub のみ非ゼロ値（iterations:3, fixes_applied:2）に差し替え、呼び出しカウンタを追加）----

/**
 * journal-log 呼び出し検証専用の VM sandbox を組む。
 * agentStub は opts.label / opts.agentType を見て phase 別に最小スキーマを返す。
 * journal-log stub の戻り値は引数 journalResult で切り替え可能。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} journalResult - journal-log stub が返すレスポンス（ログ成功/失敗を切り替え）
 * @returns {{ ctx: vm.Context, getJournalCallCount: () => number, getJournalPrompts: () => string[], getWorkflowCallCount: () => number }}
 */
function makeSandbox(analyzeReq, journalResult, journalSaveResult) {
  // journal-log (stage2) 呼び出しカウンタ
  let journalCallCount = 0;
  // journal-save (stage1) 呼び出しカウンタ・実際の telemetry payload はここに載る
  let journalSaveCallCount = 0;
  // nested workflow('pr-iterate') 呼び出しカウンタ（full 経路を通ったことの検証用）
  let workflowCallCount = 0;
  const journalPrompts = [];
  const journalLogPrompts = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
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
    // → danger clean にして HOLD 要因を発生させない
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub（最小 pass レスポンス）
    if (agentType === 'dev-flow:evaluator') {
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
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary（dev-runner-haiku）: posted:true 固定
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る。saved:true を
    // 返して journal-log (stage2) へ進めさせる。
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      journalSaveCallCount += 1;
      journalPrompts.push(prompt);
      return journalSaveResult ?? { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    // journal-log (stage2): 呼び出しカウンタをインクリメントし journalResult を返す。
    // journalResult が Error なら throw する（schema 不一致・proxy 実行失敗の再現）。
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      journalCallCount += 1;
      journalLogPrompts.push(prompt);
      if (journalResult instanceof Error) throw journalResult;
      return journalResult;
    }
    // implementer その他
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    // デフォルト: 未知の label は null を返す（journal-log が need() で包まれないことを前提）
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // pr-iterate stub: workflow() の呼び出し（非ゼロ値 — デフォルト値 0/1 との偽陽性を避ける）
  const workflowStub = async () => {
    workflowCallCount += 1;
    return { status: 'lgtm', iterations: 3, fixes_applied: 2 };
  };

  // sandbox object（devflow-journal-log.test.mjs と同一セット）
  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（devflow-journal-log.test.mjs と同一セット）
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
    getJournalSaveCallCount: () => journalSaveCallCount,
    getJournalPrompts: () => journalPrompts,
    getJournalLogPrompts: () => journalLogPrompts,
    getWorkflowCallCount: () => workflowCallCount,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * devflow-journal-log.test.mjs の runDevFlowCapture と同型：
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
// Merge tier phase まで到達させる（standard は full 経路 — lite route の TRIVIAL 条件を満たさない）
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

test('[iterate-telemetry] F2 (issue #535): nested workflow(pr-iterate) の iterations/fixes_applied が journal-save prompt の telemetry に iterate_rounds/fixes_applied として載ること', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalPrompts, getWorkflowCallCount } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // workflowStub（nested workflow('pr-iterate')）が実際に呼ばれたこと（full 経路を通ったこと）
  assert.ok(
    getWorkflowCallCount() >= 1,
    `nested workflow('pr-iterate') が呼ばれていない（lite 経路へ逸脱した可能性）。呼び出し回数: ${getWorkflowCallCount()}`,
  );

  assert.ok(result != null, 'workflow は完走し return object を解決するべきだが null/undefined だった');

  const savePrompt = getJournalPrompts()[0] ?? '';
  assert.ok(
    savePrompt.includes('"iterate_rounds":3'),
    `journal-save prompt に '"iterate_rounds":3' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt}`,
  );
  assert.ok(
    savePrompt.includes('"fixes_applied":2'),
    `journal-save prompt に '"fixes_applied":2' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt}`,
  );
});
