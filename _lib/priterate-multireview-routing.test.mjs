// F3: pr-iterate.js への多視点レビュー（2 レンズ並列 + adversarial verify）新方式 orchestration
// 配線の routing test（issue #418）。
//   - AC-1: multi_review フラグの既定値（false）で旧方式が不変（回帰）/ multi_review:true で
//     2 レンズ並列呼び出しへ切替わる
//   - AC-2: 新方式 merge → adversarial verify → classifyReviewRoute() 無変更合流（fix_loop / ci_gate）
//   - AC-3: multi mode でも reviewSeen の stuck 検出が機能する（topic 正規化 dedup 込み）
//   - AC-4: review_only による fix/CI loop 抑止・計測基盤（round metrics / ab_record）
//
// vm sandbox パターンは _lib/priterate-review-contract-routing.test.mjs と同一構造
// （makeSandbox/runPrIterate/buildAgentStub をコピーし parallel stub を含める）。

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
 * argsOverride 未指定時は単体起動 args='5'（旧方式回帰確認用の既定値）。
 */
function makeSandbox(agentStub, argsOverride) {
  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: async (fns) => Promise.all((fns || []).map((f) => f())),
    workflow: async () => ({ status: 'lgtm' }),
    args: argsOverride === undefined ? '5' : argsOverride,
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
 * reviewerStub(label) -> pr-reviewer 呼び出し（review#/-lens-/verify#）の結果（label ごとに分岐する）
 * ciStub(label) -> CI status result（省略時は常に passed）
 * fixStub(label) -> fix result（省略時は常に applied:true）
 * prMetaStub() -> pr-meta result（省略時は url/head_sha を返す）
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, prMetaStub, agentCalls }) {
  return async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    agentCalls.push({ label, agentType, prompt: promptStr });

    if (agentType === 'pr-reviewer') {
      return reviewerStub(label);
    }
    if (label === 'pr-meta') {
      return prMetaStub ? prMetaStub() : { url: 'https://github.com/o/r/pull/5', head_sha: 'headsha123' };
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
    if (label === 'ab-record') {
      return { recorded: true, path: '~/.claude/journal/ab-runs/result-5-multi-1.json' };
    }
    return null;
  };
}

// ---- [AC-1 回帰] args='5'（フラグなし）→ 旧方式不変。-lens- / verify# 呼び出しが一切発生しない ----
test('[AC-1 回帰] multi_review 未指定(既定false) -> pr-reviewer 呼び出しは review#N のみ(-lens-/verify#なし)、現行フロー lgtm', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'approve', issues: [], summary: 'ok' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 1, `pr-reviewer 呼び出しは 1 回であるべきだが ${reviewerCalls.length} 回だった`);
  assert.equal(reviewerCalls[0].label, 'review#1');
  assert.ok(!agentCalls.some((c) => c.label.includes('-lens-')), '-lens- 付き label の呼び出しがあってはならない');
  assert.ok(!agentCalls.some((c) => c.label.startsWith('verify#')), 'verify# の呼び出しがあってはならない');

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.review_mode, 'single', `review_mode は single であるべきだが '${result?.review_mode}' だった`);
});

// ---- [AC-1] multi_review:true -> review#1-lens-a / review#1-lens-b の 2 呼び出し（dimension 制限文言を含む）----
test('[AC-1] multi_review:true -> review#1-lens-a と review#1-lens-b が呼ばれ、各 prompt に dimension 制限文言を含む', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1-lens-a' || label === 'review#1-lens-b') {
      return { decision: 'approve', issues: [], summary: `ok-${label}` };
    }
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', multi_review: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const lensA = agentCalls.find((c) => c.label === 'review#1-lens-a');
  const lensB = agentCalls.find((c) => c.label === 'review#1-lens-b');
  assert.ok(lensA != null, 'review#1-lens-a が呼ばれるべき');
  assert.ok(lensB != null, 'review#1-lens-b が呼ばれるべき');
  assert.ok(lensA.prompt.includes('Correctness/Security'), `lens-a の prompt に dimension 制限文言(Correctness/Security)が含まれるべき: ${lensA.prompt.slice(0, 300)}`);
  assert.ok(lensB.prompt.includes('Testing/Maintainability/Performance'), `lens-b の prompt に dimension 制限文言が含まれるべき: ${lensB.prompt.slice(0, 300)}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しは 2 回であるべきだが ${reviewerCalls.length} 回だった`);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.review_mode, 'multi', `review_mode は multi であるべきだが '${result?.review_mode}' だった`);
});

// ---- [AC-2] multi で lens blocking 1 件 -> verify#1 呼び出し・confirmed -> fix#1 起動（classifyReviewRoute 経由 fix_loop）----
test('[AC-2] multi + lens blocking 1件 -> verify#1 が呼ばれ confirmed -> fix#1 が起動し fix 後 lgtm', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 'logic-bug::x', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = (label) => {
    if (label === 'review#1-lens-a') return { decision: 'request-changes', issues: [majorIssue], summary: 'lens-a-major' };
    if (label === 'review#1-lens-b') return { decision: 'approve', issues: [], summary: 'lens-b-clean' };
    if (label === 'verify#1') return { verdicts: [{ index: 0, verdict: 'confirmed', reason: 'realverified' }] };
    if (label === 'review#2-lens-a' || label === 'review#2-lens-b') return { decision: 'approve', issues: [], summary: 'round2-clean' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', multi_review: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const verifyCalls = agentCalls.filter((c) => c.label === 'verify#1');
  assert.equal(verifyCalls.length, 1, `verify#1 は 1 回呼ばれるべきだが ${verifyCalls.length} 回だった`);
  // マージ時に canonicalizeMergeTopic が topic を <class>::<file>（issue #418 dedup 修正）へ
  // 正規化するため、merged review の topic は元の 'logic-bug::x' ではなく 'logic-bug::a.ts' になる。
  assert.ok(verifyCalls[0].prompt.includes('logic-bug::a.ts'), 'verify prompt に対象 issue の topic が含まれるべき');

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 1, `fix# は 1 回起動されるべきだが ${fixCalls.length} 回だった`);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fixes_applied, 1, `fixes_applied は 1 であるべきだが ${result?.fixes_applied} だった`);

  const round1 = result?.history?.find((r) => r.iteration === 1);
  assert.ok(round1 != null, 'iteration 1 の history round が存在するべき');
  assert.equal(round1.verify_dropped, 0, 'confirmed のみなら verify_dropped は 0');
  assert.equal(round1.verify_fail_open, false, 'confirmed のみなら verify_fail_open は false');
  assert.equal(round1.review_agent_calls, 3, 'review_agent_calls は lens2 + verify1 = 3 であるべき');
});

// ---- [AC-2] verify が全 rejected -> issues 空 -> ci-check へ進み lgtm、round.verify_dropped===1 ----
test('[AC-2] multi + verify 全rejected -> issues 空になり ci-check 実行、lgtm、round.verify_dropped===1', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 'logic-bug::y', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1-lens-a') return { decision: 'request-changes', issues: [majorIssue], summary: 'lens-a-major' };
    if (label === 'review#1-lens-b') return { decision: 'approve', issues: [], summary: 'lens-b-clean' };
    if (label === 'verify#1') return { verdicts: [{ index: 0, verdict: 'rejected', reason: 'not-reproducible' }] };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', multi_review: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `全 rejected なら fix# は 0 回であるべきだが ${fixCalls.length} 回だった`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci.sh'));
  assert.ok(ciCalls.length > 0, 'ci-check が呼ばれるべき');

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  const round1 = result?.history?.find((r) => r.iteration === 1);
  assert.equal(round1.verify_dropped, 1, 'verify_dropped は 1 であるべき');
  assert.equal(round1.verify_fail_open, false);
});

// ---- verify null -> fail-open で findings 全保持・fix#1 起動・round.verify_fail_open===true ----
test('[fail-open] multi + verify null -> findings 全保持され fix#1 が起動、round.verify_fail_open===true', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 'logic-bug::z', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1-lens-a') return { decision: 'request-changes', issues: [majorIssue], summary: 'lens-a-major' };
    if (label === 'review#1-lens-b') return { decision: 'approve', issues: [], summary: 'lens-b-clean' };
    if (label === 'verify#1') return null;
    if (label === 'review#2-lens-a' || label === 'review#2-lens-b') return { decision: 'approve', issues: [], summary: 'round2-clean' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', multi_review: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 1, `verify null は fail-open で fix# が 1 回起動されるべきだが ${fixCalls.length} 回だった`);

  const round1 = result?.history?.find((r) => r.iteration === 1);
  assert.equal(round1.verify_fail_open, true, 'verify_fail_open は true であるべき');
  assert.equal(round1.blocking.length, 1, 'verify null で critical/major は drop されず 1 件保持されるべき');
});

// ---- [AC-4] review_only:true -> fix#/ci-check とも 0 回、status==='review_only'、history.length===1 ----
test('[AC-4] review_only:true -> fix#・ci-check 0回、status===review_only、history.length===1、round に review_mode/review_agent_calls', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 'logic-bug::ro', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'ro-round' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', review_only: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `review_only では fix# は 0 回であるべきだが ${fixCalls.length} 回だった`);
  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci.sh'));
  assert.equal(ciCalls.length, 0, `review_only では ci-check は 0 回であるべきだが ${ciCalls.length} 回だった`);

  assert.equal(result?.status, 'review_only', `status は review_only であるべきだが '${result?.status}' だった`);
  assert.equal(result?.history?.length, 1, `history.length は 1 であるべきだが ${result?.history?.length} だった`);
  const round1 = result?.history?.[0];
  assert.ok('review_mode' in round1, 'round に review_mode キーが存在するべき');
  assert.ok('review_agent_calls' in round1, 'round に review_agent_calls キーが存在するべき');
});

// ---- [AC-4] multi_review+review_only+ab_record -> label 'ab-record' の prompt に ab-runs パスを含み pending を含まない ----
test('[AC-4] multi_review+review_only+ab_record -> ab-record 呼び出しの prompt が ab-runs/result-5-multi- を含み journal/pending を含まない', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1-lens-a' || label === 'review#1-lens-b') return { decision: 'approve', issues: [], summary: `ok-${label}` };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', multi_review: true, review_only: true, ab_record: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const abCall = agentCalls.find((c) => c.label === 'ab-record');
  assert.ok(abCall != null, 'ab-record の呼び出しが存在するべき');
  assert.ok(abCall.prompt.includes('~/.claude/journal/ab-runs/'), `ab-record prompt に ~/.claude/journal/ab-runs/ を含むべき: ${abCall.prompt.slice(0, 400)}`);
  assert.ok(abCall.prompt.includes('result-5-multi-'), `ab-record prompt に result-5-multi- を含むべき: ${abCall.prompt.slice(0, 400)}`);
  assert.ok(!abCall.prompt.includes('journal/pending'), `ab-record prompt に journal/pending を含んではならない: ${abCall.prompt.slice(0, 400)}`);

  assert.equal(result?.status, 'review_only');
});

// ---- [AC-3] multi 2 iteration 同一 topic（verify confirmed・fix applied:true）-> status==='stuck' ----
test('[AC-3] multi 2 iteration 同一 topic(verify confirmed) -> reviewSeen 突合が multi 経路でも機能し status===stuck', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 'logic-bug::dup', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label.startsWith('review#') && label.includes('-lens-a')) return { decision: 'request-changes', issues: [majorIssue], summary: 'lens-a-major' };
    if (label.startsWith('review#') && label.includes('-lens-b')) return { decision: 'approve', issues: [], summary: 'lens-b-clean' };
    if (label.startsWith('verify#')) return { verdicts: [{ index: 0, verdict: 'confirmed', reason: 'still-real' }] };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub, { pr: '5', multi_review: true });
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `2 iteration 同一 topic なら status は stuck であるべきだが '${result?.status}' だった`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 1, `stuck 判定は fix 後の再 review で検出されるため fix# は 1 回であるべきだが ${fixCalls.length} 回だった`);
});

// ---- telemetry handoff（journal-log）prompt に review_mode が含まれる ----
test('[telemetry] journal-log の prompt に review_mode（telemetry handoff payload 内）が含まれる', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const journalCall = agentCalls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall != null, 'journal-log の呼び出しが存在するべき');
  assert.ok(journalCall.prompt.includes('review_mode'), `journal-log prompt に review_mode を含むべき: ${journalCall.prompt.slice(0, 500)}`);
});

// ---- return 値に head_sha が入る ----
test('[return] result に head_sha キーが含まれる（pr-meta の head_sha を転写）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const prMetaStub = () => ({ url: 'https://github.com/o/r/pull/5', head_sha: 'abc123def' });
  const agentStub = buildAgentStub({ reviewerStub, prMetaStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.ok('head_sha' in result, 'result に head_sha キーが存在するべき');
  assert.equal(result.head_sha, 'abc123def', `head_sha は pr-meta の値を転写するべきだが '${result.head_sha}' だった`);
});
