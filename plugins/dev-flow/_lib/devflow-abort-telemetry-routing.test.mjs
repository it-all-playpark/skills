// top-level abort handoff のルーティングテスト（issue #607）。
// dev-flow.js の run 本体を包む top-level try/catch が、handoff 到達前の throw（plan-review /
// evaluate / Setup 段の agent throw、および empty-diff throw との二重記録回避）で
// buildAbortHandoffPayload の単一形（outcome:'failure' + error_category:'abort'）の journal entry
// を 1 件残し、fail-open（handoff 自体の失敗が元の例外の rethrow を妨げない）であることを
// VM sandbox で検証する。makeSandbox / runDevFlowInSandbox は devflow-failure-telemetry-routing
// test.mjs の パターンを踏襲し、throwAt / journalSaveThrows / journal-log-abort stub を追加する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

function makeSandbox({
  analyzeReq, implementerFn, diffGateConfig, throwAt, journalSaveThrows, journalLogAbortResult,
} = {}) {
  const calls = [];
  let implementerCallIndex = 0;
  const { gateEmpty = false, retryEmpty = false } = diffGateConfig || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (throwAt && label === throwAt.label) throw throwAt.error;

    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label === 'issue-meta') return { ok: true, number: 1, title: analyzeReq?.issue_title ?? 'stub-issue-title' };
    if (label.startsWith('analyze')) return analyzeReq;
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [{ id: 'T1', desc: 't', file_changes: ['src/foo.ts'], test_plan: '' }], parallel: [] };
    }
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/foo.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80,
        feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      if (journalSaveThrows) throw new Error('journal-save boom');
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') return { logged: true, summary: 'ok' };
    if (label === 'journal-log-failure') return { logged: true, summary: 'ok' };
    if (label === 'journal-log-abort') {
      return journalLogAbortResult !== undefined ? journalLogAbortResult : { logged: true, summary: 'ok' };
    }
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'dev-flow:implementer') {
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
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
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

const COMPLEX_ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd', 'e'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 12,
  shape: 'complex',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const STANDARD_ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['ac1', 'ac2'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

// ============================================================
// (1) Plan ループ経路で planner が throw
// ============================================================
test('[abort-telemetry] (1) Plan ループで planner が throw → abort entry 1 件（plan#1 / shape:complex / plan_iter:1 / eval_iter:0）', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: COMPLEX_ANALYZE_REQ,
    throwAt: { label: 'plan#1', error: new Error('planner boom') },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(1) planner throw で workflow が abort すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('planner boom'),
    `(1) error.message に 'planner boom' を含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(1) journal-save は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"skill":"dev-flow"', '"outcome":"failure"', '"error_category":"abort"',
    '"error_msg":"abort@Plan/plan#1: planner boom"', '"error_phase":"Plan"',
    '"abort_phase":"Plan"', '"abort_label":"plan#1"', '"shape":"complex"',
    '"plan_iter":1', '"eval_iter":0', '"subagent_invocations"', '"gate_policy"',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(1) journal-save prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  }
  assert.ok(savePrompt.includes('/tmp/wt/.devflow-tmp/payload-devflow-1-abort.json'),
    `(1) journal-save prompt に savePath が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 1, `(1) journal-log-abort は 1 回のはずだが ${logCalls.length} 回だった`);
  const logPrompt = logCalls[0]?.prompt ?? '';
  assert.ok(logPrompt.includes('/tmp/wt/.devflow-tmp/payload-devflow-1-abort.json'),
    `(1) journal-log-abort prompt に savePath が含まれるべきだが含まれていなかった。prompt:\n${logPrompt.slice(0, 800)}`);
  assert.ok(!logPrompt.includes('"error_category"'),
    `(1) journal-log-abort prompt に結論値リテラル '"error_category"' が含まれるべきではないが含まれていた。prompt:\n${logPrompt.slice(0, 800)}`);

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 0, `(1) journal-log-failure は 0 回のはずだが ${failureCalls.length} 回だった`);
});

// ============================================================
// (2) Evaluate で evaluator が throw
// ============================================================
test('[abort-telemetry] (2) Evaluate で evaluator が throw → abort entry 1 件（eval#1 / shape:standard / plan_iter:1 / eval_iter:1）', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: STANDARD_ANALYZE_REQ,
    throwAt: { label: 'eval#1', error: new Error('evaluator boom') },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(2) evaluator throw で workflow が abort すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('evaluator boom'),
    `(2) error.message に 'evaluator boom' を含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(2) journal-save は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"error_msg":"abort@Evaluate/eval#1: evaluator boom"', '"error_phase":"Evaluate"',
    '"shape":"standard"', '"plan_iter":1', '"eval_iter":1',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(2) journal-save prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  }
});

// ============================================================
// (3) Setup（WT 未確定）で worktree agent が throw
// ============================================================
test('[abort-telemetry] (3) Setup で worktree agent が throw → WT 未確定のため tilde savePath へ退避し shape キー欠落', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: STANDARD_ANALYZE_REQ,
    throwAt: { label: 'worktree', error: new Error('worktree boom') },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(3) worktree agent throw で workflow が abort すべきだが error が null だった');

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(3) journal-save は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  assert.ok(savePrompt.includes('~/.claude/journal/abort-payload/payload-devflow-1-abort.json'),
    `(3) journal-save prompt に tilde savePath が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(savePrompt.includes('abort@Setup/worktree: worktree boom'),
    `(3) journal-save prompt に error_msg が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(!savePrompt.includes('"shape"'),
    `(3) shape 未確定のため journal-save prompt に '"shape"' キーを含むべきではないが含まれていた。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(savePrompt.includes('"plan_iter":0'),
    `(3) journal-save prompt に '"plan_iter":0' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
});

// ============================================================
// (4) fail-open: journal-save 自体が throw しても元の例外は変わらない
// ============================================================
test('[abort-telemetry] (4) fail-open: journal-save stub が throw しても元の例外(planner boom)を rethrow し journal-log-abort は 0 回', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: COMPLEX_ANALYZE_REQ,
    throwAt: { label: 'plan#1', error: new Error('planner boom') },
    journalSaveThrows: true,
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(4) error が null だった');
  assert.ok(String(error?.message ?? '').includes('planner boom'),
    `(4) handoff 自体の失敗で元の例外が置き換わってはならないが: ${error?.message}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logCalls.length, 0, `(4) journal-save が失敗した場合 journal-log-abort は 0 回のはずだが ${logCalls.length} 回だった`);
});

// ============================================================
// (5) 二重記録なし: empty_diff 経路（writeFailureTelemetry 後に throw）
// ============================================================
test('[abort-telemetry] (5) empty_diff throw は writeFailureTelemetry が記録済みのため abort entry を二重記録しない', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: { ...STANDARD_ANALYZE_REQ, issue_type: 'fix' },
    diffGateConfig: { gateEmpty: true, retryEmpty: true },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(5) empty-diff gate で throw すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('empty-diff gate'),
    `(5) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(5) journal-save は 1 回のみのはずだが ${saveCalls.length} 回だった`);

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(5) journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);

  const logFailureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(logFailureCalls.length, 1, `(5) journal-log-failure は 1 回のはずだが ${logFailureCalls.length} 回だった`);
});

// ============================================================
// (6) 完走経路（回帰）
// ============================================================
test('[abort-telemetry] (6) 完走経路: journal-log-abort が 0 回・journal-log が 1 回・journal_log_status===logged', async () => {
  const { ctx, calls } = makeSandbox({ analyzeReq: { ...STANDARD_ANALYZE_REQ, acceptance_criteria: ['ac1', 'ac2', 'ac3'] } });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(6) 完走経路では journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);

  const logCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 1, `(6) journal-log は 1 回のはずだが ${logCalls.length} 回だった`);

  assert.equal(result?.journal_log_status, 'logged',
    `(6) 完走経路では result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// (7) 静的 pin
// ============================================================
test('[abort-telemetry] (7) 静的 pin: ABORT_CTX 宣言 / try 開始位置 / failure_recorded / 末尾 catch+rethrow', () => {
  assert.equal((src.match(/const ABORT_CTX = \{/g) ?? []).length, 1,
    `(7) 'const ABORT_CTX = {' は 1 回のみのはずだが ${(src.match(/const ABORT_CTX = \{/g) ?? []).length} 回だった`);

  assert.match(src, /phase\('Setup'\)\n\s*try \{/,
    `(7) phase('Setup') の直後に 'try {' が続くべきだが見つからなかった`);

  const wftIdx = src.indexOf('async function writeFailureTelemetry(');
  assert.ok(wftIdx >= 0, `(7) writeFailureTelemetry の定義が見つからなかった`);
  const wftEndIdx = src.indexOf('\n}\n', wftIdx);
  const wftBody = src.slice(wftIdx, wftEndIdx >= 0 ? wftEndIdx : undefined);
  assert.ok(wftBody.includes('ABORT_CTX.failure_recorded = true'),
    `(7) writeFailureTelemetry 本体内に 'ABORT_CTX.failure_recorded = true' が含まれるべきだが含まれていなかった`);

  const lastCatchIdx = src.lastIndexOf('} catch (e) {');
  assert.ok(lastCatchIdx >= 0, `(7) 末尾の '} catch (e) {' ブロックが見つからなかった`);
  const tailBlock = src.slice(lastCatchIdx);
  assert.ok(tailBlock.includes('throw e'),
    `(7) 最終 '} catch (e) {' ブロック内に 'throw e' が含まれるべきだが含まれていなかった`);
});
