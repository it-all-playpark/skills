// _lib/analyze-provenance-routing.test.mjs
// dev-flow.js の Analyze phase への決定論 provenance 突合配線（issue #451 task F2）を
// VM sandbox で検証する。makeRecordingSandbox/runDevFlowInSandbox（_lib/test-helpers/vm-sandbox.mjs）と
// _lib/analyze-contract-routing.test.mjs の responder パターンを踏襲する。
//
// テストケース:
//   T1: gh 取得失敗 fixture（issue-meta が ok:false）→ needs_clarification かつ implementer 呼び出し 0 件
//   T2: 捏造 fixture（req の issue_title が probe.title と不一致）→ needs_clarification かつ implementer 0 件
//   T3: 正常系（issue_title と probe title が一致）→ implementer 呼び出し >= 1
//   T4: AC-4 pin（contract-probe fail-open → sonnet analyze 発生 + provenance 検証は適用され続ける）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

const FULL_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  breaking_change: false,
  breaking_keyword_scan: false,
  ambiguities: [],
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function createResponder({ req = FULL_REQ, issueMetaRes = { ok: true, number: 1, title: 'stub-issue-title' }, overrides = {} } = {}) {
  return function ({ label, agentType }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) return overrides[label];
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree-base-check') return { ok: true, worktree_exists: false, upstream: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label === 'issue-meta') return issueMetaRes;
    if (label.startsWith('contract-probe')) return null; // fail-open (whitelist 検証不合格扱い) — 既定は sonnet fallback
    if (label.startsWith('analyze')) return req;
    if (agentType === 'dev-planner') return { summary: 'p', serial: [{ id: 'T1', desc: 't1', file_changes: ['src/a.ts'] }], parallel: [] };
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/a.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/a.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: (req.acceptance_criteria ?? []).map((_, i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (label === 'journal-log-failure') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
    return null;
  };
}

function makeSandbox(opts) {
  const { ctx, calls } = makeRecordingSandbox(createResponder(opts), { args: '1' });
  return { ctx, calls };
}

async function run(ctx) {
  // runDevFlowInSandbox（共有ヘルパー）は error のみを返すため、return 値も欲しい本テストは
  // 直接 vm 実行して {result, error} を捕捉する（他の *-routing.test.mjs と同型）。
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;
  const vm = await import('node:vm');
  let caughtError = null;
  let resolvedResult = null;
  try {
    const promise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (promise && typeof promise.then === 'function') {
      resolvedResult = await promise.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// T1: gh 取得失敗 fixture（issue-meta が ok:false）
// ============================================================
test('[analyze-provenance-routing] T1: issue-meta probe が ok:false → needs_clarification かつ implementer 0 件', async () => {
  const { ctx, calls } = makeSandbox({ issueMetaRes: { ok: false, error: 'gh: connection failed' } });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T1');
  assert.equal(error, null, `T1: run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `T1: status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(result?.source, 'analyze', `T1: source は analyze のはずだが ${JSON.stringify(result?.source)}`);
  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.equal(implCalls.length, 0, `T1: implementer 呼び出しは 0 件のはずだが ${implCalls.length} 件`);
});

// ============================================================
// T2: 捏造 fixture（req.issue_title が probe.title と不一致）
// ============================================================
test('[analyze-provenance-routing] T2: req.issue_title が probe.title と不一致 → needs_clarification かつ implementer 0 件', async () => {
  const fabricatedReq = {
    summary: 'test',
    acceptance_criteria: ['a', 'b'],
    issue_number: 1,
    issue_title: 'test',
    breaking_change: false,
    breaking_keyword_scan: true,
    estimated_change_file_count: 1,
    shape: 'micro',
    issue_type: 'fix',
    ambiguities: [],
  };
  const { ctx, calls } = makeSandbox({
    req: fabricatedReq,
    issueMetaRes: { ok: true, number: 1, title: 'Real issue title' },
  });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T2');
  assert.equal(error, null, `T2: run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `T2: status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(result?.source, 'analyze', `T2: source は analyze のはずだが ${JSON.stringify(result?.source)}`);
  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.equal(implCalls.length, 0, `T2: implementer 呼び出しは 0 件のはずだが ${implCalls.length} 件`);
});

// ============================================================
// T3: 正常系（issue_title と probe title が一致）
// ============================================================
test('[analyze-provenance-routing] T3: issue_title と probe.title が一致 → implementer 呼び出し >= 1（Implement 到達）', async () => {
  const { ctx, calls } = makeSandbox({});
  const { error } = await run(ctx);
  assertNoCrash(error, 'T3');
  assert.equal(error, null, `T3: run が throw してはならないが: ${error?.message}`);
  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.ok(implCalls.length >= 1, `T3: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
});

// ============================================================
// T4: AC-4 pin（contract-probe fail-open → sonnet analyze 発生 + provenance 検証は適用され続ける）
// ============================================================
test('[analyze-provenance-routing] T4: contract-probe が {ok:false} でも label が analyze で始まる sonnet call が発生し、provenance 検証も適用される', async () => {
  const fabricatedReq = {
    summary: 'test',
    acceptance_criteria: ['a', 'b'],
    issue_number: 1,
    issue_title: 'test',
    breaking_change: false,
    breaking_keyword_scan: false,
    estimated_change_file_count: 1,
    shape: 'micro',
    issue_type: 'fix',
    ambiguities: [],
  };
  const { ctx, calls } = makeSandbox({
    req: fabricatedReq,
    issueMetaRes: { ok: true, number: 1, title: 'Real issue title' },
    overrides: { [`contract-probe#1`]: { ok: false, error: 'whitelist 検証不合格' } },
  });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T4');
  assert.equal(error, null, `T4: run が throw してはならないが: ${error?.message}`);

  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze') && c.agentType === 'dev-runner');
  assert.ok(analyzeCalls.length >= 1, `T4: label が 'analyze' で始まる dev-runner (sonnet) 呼び出しが 1 回以上あるはずだが ${analyzeCalls.length} 件`);

  assert.equal(result?.status, 'needs_clarification', `T4: sonnet fallback 後も provenance 検証が適用され needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.equal(implCalls.length, 0, `T4: implementer 呼び出しは 0 件のはずだが ${implCalls.length} 件`);
});
