// failure telemetry handoff のルーティングテスト（issue #225, 2-stage handoff issue #494 F3）。
// dev-flow.js の 4 つの失敗経路（analyze provenance / analyze ambiguity / implement
// NEEDS_CONTEXT / cross-repo graceful 終了。empty-diff throw も含む）に writeFailureTelemetry
// helper が呼ばれ、Merge tier 成功経路と同じ journal-save（stage1）→ journal-log-failure
// （stage2）の 2 段構成で agent 呼び出しが発生することを VM sandbox で検証する。結論値リテラル
// （outcome/error_category 等）は stage1（journal-save）の prompt にのみ現れ、stage2
// （journal-log-failure）の prompt にはファイルパスのみが現れることを確認する。
//
// needs-clarification-routing.test.mjs / empty-diff-evaluate-routing.test.mjs /
// devflow-journal-log.test.mjs の makeSandbox / VM 実行パターンを踏襲する。

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

function makeSandbox({ analyzeReq, implementerFn, diffGateConfig, journalLogFailureResult } = {}) {
  const calls = [];
  let implementerCallIndex = 0;
  const { gateEmpty = false, retryEmpty = false } = diffGateConfig || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
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
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る。成功経路・
    // failure 経路（writeFailureTelemetry）の両方が同じ label を使うため共通スタブでよい。
    if (label === 'journal-save' && agentType === 'dev-runner-haiku') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') return { logged: true, summary: 'ok' };
    // journal-log-failure (stage2): 既定は null を返す（null 容認設計を確認するため）。
    // journalLogFailureResult でケースごとに上書き可能。
    if (label === 'journal-log-failure') return journalLogFailureResult !== undefined ? journalLogFailureResult : null;
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
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

// ============================================================
// ケース (1): analyze 経路（AC 空 → needs_clarification）
// - journal-save（stage1）が 1 回発生し prompt に結論値の必須キーを含む
// - journal-log-failure（stage2）が 1 回発生し prompt にファイルパスのみを含み結論値を含まない
// - workflow の返り値が status:'needs_clarification' / source:'analyze' / journal_log_status
//   （journal-log-failure が null を返すため 'log_failed'）
// ============================================================
test('[failure-telemetry] (1) analyze 経路: AC 空 → journal-save→journal-log-failure の 2 段呼び出しがそれぞれ 1 回発生し新契約に従う', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: [],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-runner-haiku');
  assert.equal(saveCalls.length, 1,
    `(1) journal-save は 1 回のはずだが ${saveCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"needs_clarification"', '"repo":"acme/skills"']) {
    assert.ok(savePrompt.includes(key),
      `(1) journal-save prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 500)}`);
  }
  assert.ok(!savePrompt.includes('"pr_number"'),
    `(1) failure 経路は PR 作成前のため journal-save prompt に '"pr_number"' を含むべきではない。prompt:\n${savePrompt.slice(0, 500)}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-runner-haiku');
  assert.equal(logCalls.length, 1,
    `(1) journal-log-failure は 1 回のはずだが ${logCalls.length} 回だった`);
  const logPrompt = logCalls[0]?.prompt ?? '';
  assert.ok(logPrompt.includes('~/.claude/journal/pending') || logPrompt.includes('.claude/journal/pending'),
    `(1) journal-log-failure prompt に pending パスが含まれるべきだが含まれていなかった。prompt:\n${logPrompt.slice(0, 500)}`);
  assert.ok(logPrompt.includes('devflow-'),
    `(1) journal-log-failure prompt に 'devflow-' prefix が含まれるべきだが含まれていなかった。prompt:\n${logPrompt.slice(0, 500)}`);
  assert.ok(!logPrompt.includes('"outcome":"failure"'),
    `(1) journal-log-failure prompt に結論値リテラル '"outcome":"failure"' が含まれるべきではないが含まれていた。prompt:\n${logPrompt.slice(0, 500)}`);

  assert.equal(result?.status, 'needs_clarification',
    `(1) result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`);
  assert.equal(result?.source, 'analyze',
    `(1) result.source は 'analyze' のはずだが ${JSON.stringify(result?.source)} だった`);
  // journal-log-failure スタブは null を返す（既定）ため journalPost?.logged !== true → 'log_failed'
  assert.equal(result?.journal_log_status, 'log_failed',
    `(1) journal-log-failure が null（logged 不明）を返す場合 result.journal_log_status は 'log_failed' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// ケース (2): implement 経路（NEEDS_CONTEXT 解消不能 → needs_clarification）
// - journal-save（stage1）が 1 回発生し prompt に shape/plan_iter を含む
// - journal-log-failure（stage2）が logged:true を返すとき result.journal_log_status === 'logged'
// - result.source === 'implement'
// ============================================================
test('[failure-telemetry] (2) implement 経路: NEEDS_CONTEXT 解消不能 → journal-save→journal-log-failure が新契約に従い journal_log_status が配線される', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const implementerFn = () => ({
    status: 'NEEDS_CONTEXT', task_id: 'T1', files: [], summary: '', concerns: [],
    blocking_reason: null, missing_context: 'API 仕様が不明',
  });

  const { ctx, calls } = makeSandbox({ analyzeReq, implementerFn, journalLogFailureResult: { logged: true, summary: 'ok' } });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-runner-haiku');
  assert.equal(saveCalls.length, 1,
    `(2) journal-save は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"needs_clarification"', '"shape"', '"plan_iter"', '"repo":"acme/skills"']) {
    assert.ok(savePrompt.includes(key),
      `(2) journal-save prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 500)}`);
  }
  assert.ok(!savePrompt.includes('"pr_number"'),
    `(2) failure 経路は PR 作成前のため journal-save prompt に '"pr_number"' を含むべきではない。prompt:\n${savePrompt.slice(0, 500)}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-runner-haiku');
  assert.equal(logCalls.length, 1,
    `(2) journal-log-failure は 1 回のはずだが ${logCalls.length} 回だった`);
  const logPrompt = logCalls[0]?.prompt ?? '';
  assert.ok(!logPrompt.includes('"outcome":"failure"'),
    `(2) journal-log-failure prompt に結論値リテラル '"outcome":"failure"' が含まれるべきではないが含まれていた。prompt:\n${logPrompt.slice(0, 500)}`);

  assert.equal(result?.status, 'needs_clarification',
    `(2) result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`);
  assert.equal(result?.source, 'implement',
    `(2) result.source は 'implement' のはずだが ${JSON.stringify(result?.source)} だった`);
  assert.equal(result?.journal_log_status, 'logged',
    `(2) journal-log-failure が logged:true を返す場合 result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// ケース (3): empty-diff 経路（diff-gate + diff-gate-retry 両方 empty:true → throw）
// - throw 直前に journal-save→journal-log-failure がそれぞれ 1 回発生する
// - journal-save prompt に '"error_category":"empty_diff"' が含まれる
// ============================================================
test('[failure-telemetry] (3) empty-diff 経路: 両方 empty:true → throw 前に journal-save→journal-log-failure が新契約に従う', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq, diffGateConfig: { gateEmpty: true, retryEmpty: true } });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null,
    '(3) 両方 empty:true なら workflow が throw すべきだが error が null だった');
  assert.ok(typeof error?.message === 'string' && error.message.includes('empty-diff gate'),
    `(3) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-runner-haiku');
  assert.equal(saveCalls.length, 1,
    `(3) journal-save は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"empty_diff"', '"repo":"acme/skills"']) {
    assert.ok(savePrompt.includes(key),
      `(3) journal-save prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 500)}`);
  }
  assert.ok(!savePrompt.includes('"pr_number"'),
    `(3) failure 経路は PR 作成前のため journal-save prompt に '"pr_number"' を含むべきではない。prompt:\n${savePrompt.slice(0, 500)}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-runner-haiku');
  assert.equal(logCalls.length, 1,
    `(3) journal-log-failure は 1 回のはずだが ${logCalls.length} 回だった`);
  const logPrompt = logCalls[0]?.prompt ?? '';
  assert.ok(!logPrompt.includes('"outcome":"failure"'),
    `(3) journal-log-failure prompt に結論値リテラル '"outcome":"failure"' が含まれるべきではないが含まれていた。prompt:\n${logPrompt.slice(0, 500)}`);
});

// ============================================================
// ケース (4): 完走経路（全 stub 正常）
// - journal-log-failure が 0 回
// - journal-save（success）が 1 回・prompt に '"outcome":"success"' を含む
// - result.journal_log_status === 'logged'（journal-log が logged:true を返すため）
// ============================================================
test('[failure-telemetry] (4) 完走経路: journal-log-failure が 0 回・journal-save(success) が 1 回・outcome:success を含み journal_log_status が logged', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2', 'ac3'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 0,
    `(4) 完走経路では journal-log-failure は 0 回のはずだが ${failureCalls.length} 回だった`);

  // issue #494: 実際の telemetry payload（outcome 等の結論値）は journal-save (stage1) の prompt
  // に載る。journal-log (stage2) はファイルパスのみを扱い payload literal を含まない。
  const successCalls = calls.filter(
    (c) => c.label === 'journal-save' && c.agentType === 'dev-runner-haiku',
  );
  assert.equal(successCalls.length, 1,
    `(4) journal-save(success) は 1 回のはずだが ${successCalls.length} 回だった`);

  const successPrompt = successCalls[0]?.prompt ?? '';
  assert.ok(successPrompt.includes('"outcome":"success"'),
    `(4) journal-save(success) prompt に '"outcome":"success"' が含まれるべきだが:\n${successPrompt.slice(0, 500)}`);

  assert.ok(result?.pr_url != null,
    `(4) 完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)} だった`);
  assert.equal(result?.journal_log_status, 'logged',
    `(4) journal-log が logged:true を返す完走経路では result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});
