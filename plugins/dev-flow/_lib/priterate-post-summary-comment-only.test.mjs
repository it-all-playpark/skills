// pr-iterate の終端 post-summary 投稿が `gh pr comment` 単一経路であることを pin する（issue #524）
//
// 不変条件: 終端 status × lastDecision のどの組合せでも、post-summary agent への prompt に
// `gh pr review` の literal を含めない。含めると safety classifier に self-approval として
// blocked され、failOpenAgent 経由のため run は lgtm で完走したまま終端サマリーだけが PR に
// 残らない silent data loss になる（fail-open は維持したうえで原因側を断つ）。
//
// vm sandbox パターンは _lib/priterate-review-contract-routing.test.mjs と同一構造。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

/**
 * pr-iterate.js を vm sandbox で実行するための context を作る。
 * agentStub は呼び出しごとに { label, agentType, prompt } を agentCalls に記録する。
 */
function makeSandbox(agentStub) {
  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: async (fns) => Promise.all((fns || []).map((f) => f())),
    workflow: async () => ({ status: 'lgtm' }),
    args: '5',
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
  return vm.createContext(sandbox);
}

async function runPrIterate(ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/pr-iterate.js' });
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

function assertNoSandboxCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

/**
 * agentCalls を記録しつつ分岐する共通 agentStub ファクトリ。
 * reviewerStub(label) -> review result（pr-reviewer 呼び出しごとに呼ばれる）
 * ciStub(label) -> CI status result（省略時は常に passed）
 * fixStub(label) -> fix result（省略時は常に applied:true）
 * postStub(label) -> post 投稿 result（省略時は常に posted:true）
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, postStub, agentCalls }) {
  return async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    agentCalls.push({ label, agentType, prompt: promptStr });

    if (agentType === 'dev-flow:pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && promptStr.includes('check-ci --checks-data')) {
      return ciStub ? ciStub(label) : { status: 'passed', failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('post-')) {
      return postStub ? postStub(label) : { posted: true, method: 'gh', url: 'http://x' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    if (label.startsWith('commit-ensure#')) {
      return { dirty: false, committed: false, pushed: false };
    }
    return null;
  };
}

// ---- (1) lgtm + approve 終端 -> post-summary の prompt に gh pr review / --approve を含めず gh pr comment を使う ----
test('[issue #524] lgtm + approve 終端 -> post-summary prompt は gh pr review を含まず gh pr comment を使う', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);

  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  assert.ok(
    !postSummary.prompt.includes('gh pr review'),
    `post-summary の prompt に 'gh pr review' を含めてはならない。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    !postSummary.prompt.includes('--approve'),
    `post-summary の prompt に '--approve' を含めてはならない。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    postSummary.prompt.includes(`gh pr comment 5`),
    `post-summary の prompt に 'gh pr comment 5' を含むべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    postSummary.prompt.includes('--body-file'),
    `post-summary の prompt に '--body-file' を含むべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
});

// ---- (2) fix_failed + request-changes + blocking>0 終端 -> post-summary の prompt に gh pr review / --request-changes を含めず gh pr comment を使う ----
test('[issue #524] fix_failed + request-changes(blocking>0) 終端 -> post-summary prompt は gh pr review を含まず gh pr comment を使う', async () => {
  const agentCalls = [];
  const criticalIssue = { severity: 'critical', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [criticalIssue], summary: 'ng' });
  const fixStub = () => ({ applied: false, summary: 'cannot', files: [] });
  const agentStub = buildAgentStub({ reviewerStub, fixStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);

  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  assert.ok(
    !postSummary.prompt.includes('gh pr review'),
    `post-summary の prompt に 'gh pr review' を含めてはならない。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    !postSummary.prompt.includes('--request-changes'),
    `post-summary の prompt に '--request-changes' を含めてはならない。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    postSummary.prompt.includes(`gh pr comment 5`),
    `post-summary の prompt に 'gh pr comment 5' を含むべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
});

// ---- (3) lgtm + comment 終端（回帰）-> post-summary の prompt は gh pr review を含まず gh pr comment を使う ----
test('[issue #524 回帰] lgtm + comment 終端 -> post-summary prompt は gh pr review を含まず gh pr comment を使う（既存 comment 経路の不変）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'comment', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);

  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  assert.ok(
    !postSummary.prompt.includes('gh pr review'),
    `post-summary の prompt に 'gh pr review' を含めてはならない。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    postSummary.prompt.includes(`gh pr comment 5`),
    `post-summary の prompt に 'gh pr comment 5' を含むべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
});

// ---- (4) fail-open 維持（AC-3）: posted:false でも run が throw せず完走する ----
test('[issue #524 AC-3] post-summary が posted:false を返しても run は throw せず lgtm で完走する（fail-open 維持）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const postStub = (label) => (label === 'post-summary' ? { posted: false, method: '', url: '' } : { posted: true, method: 'gh', url: 'http://x' });
  const agentStub = buildAgentStub({ reviewerStub, postStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  assert.equal(error, null, `run は throw せず完走するべきだが error が発生した: ${error?.name}: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (5) static 回帰ピン: pr-iterate.js の source 全文に 'gh pr review' literal が存在しない ----
test('[issue #524 static pin] pr-iterate.js の source に \'gh pr review\' literal が存在しない（恒久回帰防止）', () => {
  assert.ok(!src.includes('gh pr review'), `pr-iterate.js に 'gh pr review' literal が残存している（self-approval として classifier に blocked される原因）`);
});
