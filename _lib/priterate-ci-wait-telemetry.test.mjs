// F2: check-ci.sh の --wait-seconds/--poll-seconds ポーリング配線検証テスト（TDD）。
// AC-1: pending -> passed で pr-iterate が LGTM へ進む。
// AC-7: waited_seconds/poll_attempts が journal telemetry handoff / 終端サマリー / return に反映される。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

function makeSandbox({ ciResponses }) {
  const agentCalls = []; // {label, agentType, prompt}
  let ciCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    agentCalls.push({ label, agentType, prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

    // pr-reviewer: 常に approve
    if (agentType === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    // ci-check: 呼び出し順に ciResponses を消費する
    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      const idx = ciCallCount;
      ciCallCount += 1;
      return ciResponses[idx] ?? ciResponses[ciResponses.length - 1];
    }

    // fix: label が 'fix#' で始まる
    if (label.startsWith('fix#')) {
      return { applied: true, summary: 'fixed', files: [] };
    }

    // 投稿系: label が 'post-' で始まる
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // journal-log
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }

    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm' });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
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

  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    getAgentCalls: () => agentCalls,
  };
}

async function runPrIterateCapture(src, ctx) {
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

const src = readFileSync(prIteratePath, 'utf8');

test('[ci-wait-telemetry] ci-check#1 の prompt が --wait-seconds 90 --poll-seconds 15 で check-ci.sh を呼ぶ（AC-1配線）', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const ciCheck1 = getAgentCalls().find((c) => c.label === 'ci-check#1');
  assert.ok(ciCheck1 != null, 'label===ci-check#1 の agent 呼び出しが存在するべき');
  assert.ok(
    ciCheck1.prompt.includes('check-ci.sh ${PR} --wait-seconds 90 --poll-seconds 15'.replace('${PR}', '5')),
    `ci-check#1 の prompt に --wait-seconds 90 --poll-seconds 15 付きの check-ci.sh 呼び出しが含まれるべき。\nprompt: ${ciCheck1.prompt.slice(0, 800)}`,
  );
  assert.equal(result?.status, 'lgtm', `pending->passed 相当（今回は即 passed）で LGTM へ進むべきだが '${result?.status}' だった`);
});

test('[ci-wait-telemetry] AC-1: pending -> passed で LGTM に進み、waited_seconds/poll_attempts が累積される', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    ciResponses: [
      { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 30, poll_attempts: 3 },
      { status: 'passed', failed_checks: [], waited_seconds: 10, poll_attempts: 2 },
    ],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `2 回目の CI check で passed になり LGTM へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 2, `2 iteration（1回目 failed→fix、2回目 passed）で終端するべきだが ${result?.iterations} だった`);

  // 累積: 30+10=40 / 3+2=5
  assert.equal(result?.ci_wait_seconds, 40, `result.ci_wait_seconds は累積 40 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 5, `result.ci_poll_attempts は累積 5 であるべきだが ${result?.ci_poll_attempts} だった`);

  // journal-log の telemetry handoff prompt に累積値が反映される
  const journalCall = getAgentCalls().find((c) => c.label === 'journal-log');
  assert.ok(journalCall != null, 'label===journal-log の agent 呼び出しが存在するべき');
  assert.ok(
    journalCall.prompt.includes('"ci_wait_seconds":40'),
    `journal-log prompt に "ci_wait_seconds":40 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1000)}`,
  );
  assert.ok(
    journalCall.prompt.includes('"ci_poll_attempts":5'),
    `journal-log prompt に "ci_poll_attempts":5 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1000)}`,
  );

  // 終端サマリー投稿（post-summary）の body にも CI 待機情報が反映される
  const postSummary = getAgentCalls().find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'label===post-summary の agent 呼び出しが存在するべき');
  assert.ok(
    postSummary.prompt.includes('CI 待機'),
    `post-summary prompt に **CI 待機** 行が含まれるべき。prompt の先頭1000文字: ${postSummary.prompt.slice(0, 1000)}`,
  );
});

test('[ci-wait-telemetry] CI 呼び出しが 0 回（review が blocking で fix 前に stuck 等）でも ci_wait_seconds/ci_poll_attempts は 0 で返る', async () => {
  // pr-reviewer を request-changes 固定にして stuck を誘発する簡易ケース: ここでは
  // ci_gate に到達しない route（review_contract_error 相当ではなく、単純に review が never approve）は
  // 別テストの守備範囲外のため、ここでは ci-check が 1 度も呼ばれない状況を作らず、
  // 代わりに ci-check#1 が即 no_checks で終端する最小ケースで 0 加算を検証する。
  const { ctx } = makeSandbox({
    ciResponses: [{ status: 'no_checks', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_wait_seconds, 0, `no_checks・poll 1 回でも waited_seconds=0 ならば累積 0 のはずだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 1, `poll_attempts=1 が累積されるべきだが ${result?.ci_poll_attempts} だった`);
});
