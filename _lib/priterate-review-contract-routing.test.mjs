// F3: pr-iterate の review 経路（decision × blocking）route ベース再構成の routing test（issue #321）
// classifyReviewRoute（_lib/review-normalize.mjs）ベースの分岐を pin する:
//   - blocking 0 件 → ci_gate（decision に依らず fix agent を起動しない）
//   - approve + blocking あり → 同一 iteration 内で 1 回だけ再 review（contract retry）
//     - 再矛盾 → status: 'review_contract_error'（無限ループしない）
//     - 解消 → ci_gate / fix_loop へ正しく合流
//   - minor findings は fix loop を起動しないが per-round コメント・終端サマリーに保持される
//   - 既存正常経路（approve→CI gate、request-changes→fix loop）は不変（AC-6 回帰）
//
// vm sandbox パターンは _lib/priterate-max-iterations.test.mjs / priterate-ci-history.test.mjs と同一構造。

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
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, agentCalls }) {
  return async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    agentCalls.push({ label, agentType, prompt: promptStr });

    if (agentType === 'pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-runner-haiku-ro' && promptStr.includes('check-ci.sh')) {
      return ciStub ? ciStub(label) : { status: 'passed', failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    return null;
  };
}

// ---- (1) [AC-1] comment + minor 1 件のみ -> fix agent を起動せず CI gate へ進み lgtm ----
test('[AC-1] comment decision + minor 1 件のみ(blocking 0件) -> fix# 起動なし、ci-check 実行、lgtm', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({
    decision: 'comment',
    issues: [{ severity: 'minor', topic: 'm1', file: 'a.ts', description: 'minor-desc-ac1', suggestion: 'minor-sugg-ac1' }],
    summary: 'ok',
  });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci.sh'));
  assert.ok(ciCalls.length > 0, 'ci-check（check-ci.sh）が呼ばれるべき');

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回呼ばれた`);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (2) [AC-2] request-changes + issues:[] -> fix agent を起動せず CI gate へ進み lgtm ----
test('[AC-2] request-changes decision + issues:[](blocking 0件) -> fix# 起動なし、ci-check 実行、lgtm', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'request-changes', issues: [], summary: 'ok-empty' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci.sh'));
  assert.ok(ciCalls.length > 0, 'ci-check（check-ci.sh）が呼ばれるべき');

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回呼ばれた`);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (3) [AC-3] approve+blocking の再 review が矛盾解消 -> fix loop へ合流 -> lgtm ----
test('[AC-3] approve+major の1回だけ再reviewで矛盾解消(request-changes) -> fix loop 合流 -> fix後 lgtm', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'approve', issues: [majorIssue], summary: 'mismatch-round1' };
    if (label === 'review#1-contract-retry') return { decision: 'request-changes', issues: [majorIssue], summary: 'resolved-to-request-changes' };
    if (label === 'review#2') return { decision: 'approve', issues: [], summary: 'ok-round2' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 3, `pr-reviewer 呼び出しは 3 回（review#1 + retry + review#2）であるべきだが ${reviewerCalls.length} 回だった。labels: ${reviewerCalls.map((c) => c.label).join(', ')}`);
  assert.ok(reviewerCalls.some((c) => c.label === 'review#1'), 'review#1 が呼ばれるべき');
  assert.ok(reviewerCalls.some((c) => c.label === 'review#1-contract-retry'), 'review#1-contract-retry が呼ばれるべき');
  assert.ok(reviewerCalls.some((c) => c.label === 'review#2'), 'fix 後の review#2 が呼ばれるべき');

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 1, `fix# は 1 回であるべきだが ${fixCalls.length} 回だった`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (4) [AC-4] 再試行後も矛盾再発 -> review_contract_error で終端（無限ループしない）----
test('[AC-4] approve+major が retry 後も再発 -> review_contract_error で終端、無限ループしない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1' || label === 'review#1-contract-retry') {
      return { decision: 'approve', issues: [majorIssue], summary: 'still-mismatched' };
    }
    throw new Error(`unexpected pr-reviewer label (should not go past retry): ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しは 2 回のみ（review#1 + retry、無限ループしない）であるべきだが ${reviewerCalls.length} 回だった`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回だった`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci.sh'));
  assert.equal(ciCalls.length, 0, `ci-check は 0 回であるべきだが ${ciCalls.length} 回だった`);

  assert.equal(result?.status, 'review_contract_error', `result.status は review_contract_error であるべきだが '${result?.status}' だった`);
});

// ---- (5) [AC-5] minor findings は消えず per-round コメント・終端サマリーに保持される ----
test('[AC-5] minor findings が post-review# と post-summary の本文に保持される（fix loop 対象外）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({
    decision: 'comment',
    issues: [{ severity: 'minor', topic: 'm1', file: 'a.ts', description: 'minor-desc-ac5-unique', suggestion: 'minor-sugg-ac5-unique' }],
    summary: 'ok',
  });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  assert.equal(result?.status, 'lgtm', `前提: lgtm であるべきだが '${result?.status}' だった`);

  const postReview1 = agentCalls.find((c) => c.label === 'post-review#1');
  assert.ok(postReview1 != null, 'post-review#1 の呼び出しが存在するべき');
  assert.ok(
    postReview1.prompt.includes('minor-desc-ac5-unique'),
    `post-review#1 の prompt に minor description が含まれるべき。先頭800文字: ${postReview1.prompt.slice(0, 800)}`,
  );

  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  assert.ok(
    postSummary.prompt.includes('minor-desc-ac5-unique'),
    `post-summary の prompt に minor description が含まれるべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
});

// ---- (6) [AC-6 回帰・その1] 通常 approve -> CI gate -> lgtm（retry 呼び出し 0）----
test('[AC-6 回帰] approve + issues:[] + CI passed -> lgtm（retry label 呼び出し 0、既存正常経路不変）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const retryCalls = agentCalls.filter((c) => c.label.includes('contract-retry'));
  assert.equal(retryCalls.length, 0, `retry 呼び出しは 0 回であるべきだが ${retryCalls.length} 回だった`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (6b) [AC-6 回帰・その2] request-changes + blocking -> fix loop 継続（既存正常経路不変）----
test('[AC-6 回帰] request-changes + [major](topic毎回ユニーク) -> fix# 起動、applied:true で反復継続', async () => {
  const agentCalls = [];
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) {
      return {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: `t-round-${round}`, file: 'a.ts', description: `d${round}`, suggestion: `s${round}` }],
        summary: 'ng',
      };
    }
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.ok(fixCalls.length >= 1, `fix# が少なくとも 1 回呼ばれるべきだが ${fixCalls.length} 回だった`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fixes_applied, 1, `fixes_applied は 1 であるべきだが ${result?.fixes_applied} だった`);
});

// ---- (7) [AC-6 回帰・その3] approve + issues:[] だが CI failed -> CI fix agent は従来どおり起動する ----
test('[AC-6 回帰] approve + issues:[] だが CI failed -> CI gate 内の fix agent は従来どおり起動する', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  let ciCallCount = 0;
  const ciStub = () => {
    ciCallCount += 1;
    if (ciCallCount === 1) {
      return { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'test', state: 'failure' }] };
    }
    return { status: 'passed', failed_checks: [] };
  };
  const agentStub = buildAgentStub({ reviewerStub, ciStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.ok(fixCalls.length >= 1, `CI failed の修正 fix# が少なくとも 1 回呼ばれるべきだが ${fixCalls.length} 回だった`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (8) [ci_gate 投稿] request-changes+blocking0+CI passed の投稿に --approve が含まれない（approve 捏造禁止）----
test('[ci_gate 投稿] request-changes decision + blocking 0 + CI passed の post-review# prompt に --approve が含まれない', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'request-changes', issues: [], summary: 'ok-empty' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  assert.equal(result?.status, 'lgtm', `前提: lgtm であるべきだが '${result?.status}' だった`);

  const postReview1 = agentCalls.find((c) => c.label === 'post-review#1');
  assert.ok(postReview1 != null, 'post-review#1 の呼び出しが存在するべき');
  assert.ok(
    !postReview1.prompt.includes('--approve'),
    `post-review#1 の prompt に --approve を含めてはならない（reviewer が approve していないため）。先頭800文字: ${postReview1.prompt.slice(0, 800)}`,
  );
});
