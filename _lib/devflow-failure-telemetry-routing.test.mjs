// failure telemetry handoff のルーティングテスト（issue #225）。
// dev-flow.js の 3 つの失敗経路に writeFailureTelemetry helper が呼ばれ、
// label='journal-log-failure' / agentType='dev-runner-haiku' の agent 呼び出しが発生し、
// prompt に正しい JSON キーが含まれることを VM sandbox で検証する。
//
// needs-clarification-routing.test.mjs / empty-diff-evaluate-routing.test.mjs /
// devflow-journal-log.test.mjs の makeSandbox / VM 実行パターンを踏襲する。

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

function makeSandbox({ analyzeReq, implementerFn, diffGateConfig } = {}) {
  const calls = [];
  let implementerCallIndex = 0;
  const { gateEmpty = false, retryEmpty = false } = diffGateConfig || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return analyzeReq;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 'T1', desc: 't', file_changes: ['src/foo.ts'], test_plan: '' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/foo.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80,
        feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') return { logged: true, summary: 'ok' };
    // journal-log-failure: null を返す（null 容認設計を確認するため）
    if (label === 'journal-log-failure') return null;
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'implementer') {
      const fn = implementerFn ?? (() => ({
        status: 'DONE', task_id: 'T1', files: [], summary: '', concerns: [],
        blocking_reason: null, missing_context: null,
      }));
      const result = fn(implementerCallIndex);
      implementerCallIndex++;
      return result;
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub, parallel: parallelStub,
    workflow: workflowStub, args: '1',
    console, JSON, Math, String, Number, Boolean, Array, Object, Error,
    RegExp, Promise, Symbol, Map, Set, Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

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
      result = await promise.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, result };
}

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// ケース (1): analyze 経路（AC 空 → needs_clarification）
// - label='journal-log-failure' / agentType='dev-runner-haiku' が 1 回発生する
// - prompt に '"outcome":"failure"' / '"error_category":"needs_clarification"' /
//   '~/.claude/journal/pending' / 'devflow-' が含まれる
// - workflow の返り値が status:'needs_clarification' / source:'analyze' のまま
// ============================================================
test('[failure-telemetry] (1) analyze 経路: AC 空 → journal-log-failure が 1 回発生し prompt に必須キーを含む', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: [],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 1,
    `(1) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);

  assert.equal(failureCalls[0]?.agentType, 'dev-runner-haiku',
    `(1) agentType は 'dev-runner-haiku' のはずだが '${failureCalls[0]?.agentType}' だった`);

  const prompt = failureCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"needs_clarification"', '~/.claude/journal/pending', 'devflow-']) {
    assert.ok(prompt.includes(key),
      `(1) prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${prompt.slice(0, 500)}`);
  }

  assert.equal(result?.status, 'needs_clarification',
    `(1) result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`);
  assert.equal(result?.source, 'analyze',
    `(1) result.source は 'analyze' のはずだが ${JSON.stringify(result?.source)} だった`);
});

// ============================================================
// ケース (2): implement 経路（NEEDS_CONTEXT 解消不能 → needs_clarification）
// - label='journal-log-failure' が 1 回発生する
// - prompt に '"outcome":"failure"' / '"error_category":"needs_clarification"' /
//   '"shape"' / '"plan_iter"' が含まれる
// - result.source === 'implement'
// ============================================================
test('[failure-telemetry] (2) implement 経路: NEEDS_CONTEXT 解消不能 → journal-log-failure が 1 回・prompt に shape/plan_iter を含む', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  const implementerFn = () => ({
    status: 'NEEDS_CONTEXT', task_id: 'T1', files: [], summary: '', concerns: [],
    blocking_reason: null, missing_context: 'API 仕様が不明',
  });

  const { ctx, calls } = makeSandbox({ analyzeReq, implementerFn });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 1,
    `(2) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回だった`);

  const prompt = failureCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"needs_clarification"', '~/.claude/journal/pending', 'devflow-', '"shape"', '"plan_iter"']) {
    assert.ok(prompt.includes(key),
      `(2) prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${prompt.slice(0, 500)}`);
  }

  assert.equal(result?.status, 'needs_clarification',
    `(2) result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`);
  assert.equal(result?.source, 'implement',
    `(2) result.source は 'implement' のはずだが ${JSON.stringify(result?.source)} だった`);
});

// ============================================================
// ケース (3): empty-diff 経路（diff-gate + diff-gate-retry 両方 empty:true → throw）
// - throw 直前に journal-log-failure が 1 回発生する
// - prompt に '"error_category":"empty_diff"' が含まれる
// ============================================================
test('[failure-telemetry] (3) empty-diff 経路: 両方 empty:true → throw 前に journal-log-failure が 1 回・prompt に empty_diff を含む', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq, diffGateConfig: { gateEmpty: true, retryEmpty: true } });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null,
    '(3) 両方 empty:true なら workflow が throw すべきだが error が null だった');
  assert.ok(typeof error?.message === 'string' && error.message.includes('empty-diff gate'),
    `(3) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 1,
    `(3) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回だった`);

  const prompt = failureCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"empty_diff"', '~/.claude/journal/pending', 'devflow-']) {
    assert.ok(prompt.includes(key),
      `(3) prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${prompt.slice(0, 500)}`);
  }
});

// ============================================================
// ケース (4): 完走経路（全 stub 正常）
// - label='journal-log-failure' が 0 回
// - label='journal-log'（success）が 1 回・prompt に '"outcome":"success"' を含む
// ============================================================
test('[failure-telemetry] (4) 完走経路: journal-log-failure が 0 回・journal-log(success) が 1 回・outcome:success を含む', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2', 'ac3'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 0,
    `(4) 完走経路では journal-log-failure は 0 回のはずだが ${failureCalls.length} 回だった`);

  const successCalls = calls.filter(
    (c) => c.label === 'journal-log' && c.agentType === 'dev-runner-haiku',
  );
  assert.equal(successCalls.length, 1,
    `(4) journal-log(success) は 1 回のはずだが ${successCalls.length} 回だった`);

  const successPrompt = successCalls[0]?.prompt ?? '';
  assert.ok(successPrompt.includes('"outcome":"success"'),
    `(4) journal-log(success) prompt に '"outcome":"success"' が含まれるべきだが:\n${successPrompt.slice(0, 500)}`);

  assert.ok(result?.pr_url != null,
    `(4) 完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)} だった`);
});
