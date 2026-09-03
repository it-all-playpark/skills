// F3: pr-iterate の終端 dirty 検出（AC-2）と fix 適用直後の commit 保証（AC-3）の routing test（issue #437）
//   - fix 適用（applied:true）直後、ensure-committed.sh を exec-proxy で実行し worktree の未コミット変更を
//     検証する。dirty:false は no-op で継続、dirty:true で commit+push が成功すれば継続（回収カウンタ加算）、
//     null/schema 不一致/回収失敗（committed&&pushed でない）は fail-safe で terminal:'fix_failed'。
//   - status !== 'lgtm' の終端でのみ、worktree-dirty-check（--check-only）の advisory probe を実行する。
//     probe 失敗は fail-open（'unknown' + 警告のみ）。lgtm 終端では probe しない（agent 呼び出し追加ゼロ）。
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
 * commitEnsureStub(label) -> commit-ensure（--pr --iteration）result（省略時は { dirty: false, committed: false, pushed: false }）
 * dirtyCheckStub(label) -> worktree-dirty-check（--check-only）result（省略時は未 stub 扱い＝null、fail-open）
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, commitEnsureStub, dirtyCheckStub, agentCalls }) {
  return async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    agentCalls.push({ label, agentType, prompt: promptStr });

    if (agentType === 'pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-runner-haiku-ro' && promptStr.includes('check-ci --checks-data')) {
      return ciStub ? ciStub(label) : { status: 'passed', failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('commit-ensure#')) {
      return commitEnsureStub ? commitEnsureStub(label) : { dirty: false, committed: false, pushed: false };
    }
    if (label === 'worktree-dirty-check') {
      return dirtyCheckStub ? dirtyCheckStub(label) : null;
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') {
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    // pr-meta: cwd は実 run では常に worktree の絶対パス。journal-save の保存先はここから組み立てられる。
    if (label === 'pr-meta') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
    }
    return null;
  };
}

// ---- D1 [AC-3]: commit-ensure が dirty:false（正常ケース）-> no-op で継続、lgtm ----
test('[D1][AC-3] fix applied:true + commit-ensure dirty:false -> commit-ensure#1 が --pr --iteration 1 で呼ばれ、no-op で lgtm', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const commitEnsureCalls = agentCalls.filter((c) => c.label.startsWith('commit-ensure#'));
  assert.equal(commitEnsureCalls.length, 1, `commit-ensure# は 1 回であるべきだが ${commitEnsureCalls.length} 回だった`);
  const commitEnsurePrompt = commitEnsureCalls[0].prompt;
  assert.ok(
    commitEnsurePrompt.includes('git') && commitEnsurePrompt.includes('status --porcelain'),
    `commit-ensure#1 の prompt に 'git' と 'status --porcelain' を含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
  );
  assert.ok(
    commitEnsurePrompt.includes('fix(pr-5)'),
    `commit-ensure#1 の prompt に 'fix(pr-5)' コミットメッセージを含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
  );
  for (const forbidden of ['ensure-committed.sh', ['~/.claude', 'skills'].join('/'), 'sandbox', 'excludedCommands']) {
    assert.ok(
      !commitEnsurePrompt.includes(forbidden),
      `commit-ensure#1 の prompt は '${forbidden}' を含んではならない。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
    );
  }

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0, `fix_uncommitted_recovered は 0 であるべきだが ${result?.fix_uncommitted_recovered} だった`);
});

// ---- D2 [AC-3 回収]: commit-ensure が dirty:true+committed+pushed -> 継続して lgtm、回収カウンタ加算 ----
test('[D2][AC-3 回収] commit-ensure dirty:true+committed:true+pushed:true -> 継続して lgtm、fix_uncommitted_recovered=1', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: true, committed: true, pushed: true });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 1, `fix_uncommitted_recovered は 1 であるべきだが ${result?.fix_uncommitted_recovered} だった`);
});

// ---- D3 [AC-3 fail-safe]: commit-ensure が null -> fix_failed、review#2 は呼ばれない ----
test('[D3][AC-3 fail-safe] commit-ensure が null -> status:fix_failed、review#2 は呼ばれない（pr-reviewer 呼び出し1回）', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label (review#2 should not run): ${label}`);
  };
  const commitEnsureStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 1, `pr-reviewer 呼び出しは 1 回であるべきだが ${reviewerCalls.length} 回だった`);
  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
});

// ---- D4 [AC-3 fail-safe]: commit-ensure が dirty:true+committed:true+pushed:false（push 失敗）-> fix_failed ----
test('[D4][AC-3 fail-safe] commit-ensure dirty:true+committed:true+pushed:false -> status:fix_failed', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const commitEnsureStub = () => ({ dirty: true, committed: true, pushed: false });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
});

// ---- D5 [AC-2]: stuck 終端 + worktree-dirty-check dirty:true -> result.worktree_dirty='dirty'、journal-log prompt に含まれる ----
test('[D5][AC-2] stuck 終端 + worktree-dirty-check dirty:true -> result.worktree_dirty=dirty、journal-log prompt に worktree_dirty を含む', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => ({ dirty: true, files: 2 });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, dirtyCheckStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'dirty', `result.worktree_dirty は dirty であるべきだが '${result?.worktree_dirty}' だった`);

  const journalCall = agentCalls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'journal-log の呼び出しが存在するべき');
  assert.ok(
    journalCall.prompt.includes('worktree_dirty'),
    `journal-log の prompt に 'worktree_dirty' が含まれるべき。先頭800文字: ${journalCall.prompt.slice(0, 800)}`,
  );
});

// ---- D6 [AC-2 fail-open]: stuck 終端 + worktree-dirty-check probe が null -> worktree_dirty='unknown'、落ちない ----
test('[D6][AC-2 fail-open] stuck 終端 + worktree-dirty-check probe が null -> status:stuck（落ちない）、worktree_dirty=unknown', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, dirtyCheckStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'unknown', `result.worktree_dirty は unknown であるべきだが '${result?.worktree_dirty}' だった`);
});

// ---- D7 [AC-2 lgtm 非実施]: 正常 lgtm 経路 -> worktree-dirty-check は呼ばれず、worktree_dirty=null ----
test('[D7][AC-2 lgtm 非実施] 正常 lgtm 経路 -> worktree-dirty-check 呼び出し0回、result.worktree_dirty=null、journal-log prompt に含まれない', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);

  const dirtyCheckCalls = agentCalls.filter((c) => c.label === 'worktree-dirty-check');
  assert.equal(dirtyCheckCalls.length, 0, `worktree-dirty-check の呼び出しは 0 回であるべきだが ${dirtyCheckCalls.length} 回だった`);
  assert.equal(result?.worktree_dirty, null, `result.worktree_dirty は null であるべきだが '${result?.worktree_dirty}' だった`);

  const journalCall = agentCalls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'journal-log の呼び出しが存在するべき');
  assert.ok(
    !journalCall.prompt.includes('worktree_dirty'),
    `journal-log の prompt に 'worktree_dirty' を含めてはならない（lgtm 終端は probe しない）。先頭800文字: ${journalCall.prompt.slice(0, 800)}`,
  );
});
