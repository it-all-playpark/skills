// issue #371 F2: dev-flow.js の duration telemetry 配線を検証する実行ベース統合テスト。
// devflow-journal-log.test.mjs の makeSandbox / runDevFlowCapture / ANALYZE_REQ を同型コピーし
// (repo precedent はテストごとの helper 複製)、agentStub に clock# probe 分岐を追加する。
//
// clockMode='ok'   : 全 11 probe が {ok:true, epoch: 1000, 1010, ...} を順に返す
//                     （CLOCK_MARK_ORDER の発火順と一致 → 各 phase 差分 =10、全体 =100）。
// clockMode='fail' : 全 probe が null を返す（fail-open）
//                     → journal-log prompt に duration_seconds/phase_durations が現れない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（devflow-journal-log.test.mjs の makeSandbox / runDevFlowCapture と同型）----

/**
 * duration telemetry 検証専用の VM sandbox を組む。
 * clockMode='ok' なら clock# probe に {ok:true, epoch} を順次インクリメントして返す。
 * clockMode='fail' なら clock# probe は null（fail-open 経路）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {'ok'|'fail'} clockMode - clock# probe の応答モード
 * @returns {{ ctx: vm.Context, getJournalPrompts: () => string[] }}
 */
function makeSandbox(analyzeReq, clockMode) {
  const journalPrompts = [];
  let clockEpoch = 1000;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // clock# probe (issue #371 F2)
    if (label.startsWith('clock#')) {
      if (clockMode === 'fail') return null;
      clockEpoch += 10;
      return { ok: true, epoch: clockEpoch };
    }
    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
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
      return { pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true };
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
    // journal-log: prompt を捕捉して {logged:true} を返す
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { logged: true, summary: 'ok' };
    }
    // implementer その他
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // デフォルト: 未知の label は null を返す
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
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

  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    getJournalPrompts: () => journalPrompts,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * devflow-journal-log.test.mjs の runDevFlowCapture と同型。
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
// Merge tier phase まで到達させる（Evaluate も実行される = 11 probe 全発火）
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

const src = readFileSync(devFlowPath, 'utf8');

test('[duration-telemetry] clockMode=ok: journal-log prompt に duration_seconds=100 と phase_durations(analyze:10, final:10 等)が含まれる', async () => {
  const { ctx, getJournalPrompts } = makeSandbox(ANALYZE_REQ, 'ok');

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result !== null && result !== undefined, 'workflow は正常 return するべき');

  const capturedPrompt = getJournalPrompts()[0] ?? '';
  assert.ok(
    capturedPrompt.includes('"duration_seconds":100'),
    `journal-log prompt に "duration_seconds":100 が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
  );
  assert.ok(
    capturedPrompt.includes('"phase_durations"'),
    `journal-log prompt に "phase_durations" が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
  );
  assert.ok(
    capturedPrompt.includes('"analyze":10'),
    `journal-log prompt に "analyze":10 が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
  );
  assert.ok(
    capturedPrompt.includes('"final":10'),
    `journal-log prompt に "final":10 が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
  );
});

test('[duration-telemetry] clockMode=fail: journal-log prompt に duration_seconds も phase_durations も現れず、result.merge_tier は正常に返る（fail-open 回帰検出）', async () => {
  const { ctx, getJournalPrompts } = makeSandbox(ANALYZE_REQ, 'fail');

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    result !== null && result !== undefined,
    `clock probe 全滅（fail-open）でも workflow は return object を解決するべきだが null/undefined だった`,
  );
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `clock probe 全滅でも result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );

  const capturedPrompt = getJournalPrompts()[0] ?? '';
  assert.ok(
    !capturedPrompt.includes('"duration_seconds"'),
    `clock probe 全滅時は journal-log prompt に "duration_seconds" が含まれないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
  assert.ok(
    !capturedPrompt.includes('"phase_durations"'),
    `clock probe 全滅時は journal-log prompt に "phase_durations" が含まれないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
});
