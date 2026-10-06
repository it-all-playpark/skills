// pr-iterate.js の終端情報（terminal_path / fix_terminal_reason / history）が返り値に載り、
// telemetry（journal-log payload）は merge_tier / iterate_status / review_model_config /
// plugin_version / plugin_commit だけを書くことの検証テスト。issue #601 / #789。
// telemetryHandoff（journal-log prompt に verbatim 転写される payload）は
// <<<JOURNAL_HANDOFF_BODY_BEGIN>>> / <<<JOURNAL_HANDOFF_BODY_END>>> の間を JSON.parse して検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { PLUGIN_VERSION } from './plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

function extractJournalPayload(prompt) {
  const body = prompt.split('<<<JOURNAL_HANDOFF_BODY_BEGIN>>>')[1].split('<<<JOURNAL_HANDOFF_BODY_END>>>')[0].trim();
  return JSON.parse(body);
}

function makeSandbox({ reviewerStub, fixSequence = [], commitEnsureResult, ciResponses = [] }) {
  const agentCalls = []; // {label, agentType, prompt}
  let reviewCallCount = 0;
  let fixCallCount = 0;
  let ciCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    agentCalls.push({ label, agentType, prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

    // pr-reviewer: reviewerStub(呼出回数)
    if (agentType === 'dev-flow:pr-reviewer') {
      const idx = reviewCallCount;
      reviewCallCount += 1;
      return reviewerStub(idx + 1);
    }

    // fix: label が 'fix#' で始まる
    if (label.startsWith('fix#')) {
      const idx = fixCallCount;
      fixCallCount += 1;
      return fixSequence[idx] ?? fixSequence[fixSequence.length - 1];
    }

    // ci-check: agentType dev-runner-haiku-ro かつ prompt に 'check-ci --checks-data'
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci --checks-data')) {
      const idx = ciCallCount;
      ciCallCount += 1;
      return ciResponses[idx] ?? ciResponses[ciResponses.length - 1];
    }

    // commit-ensure
    if (label.startsWith('commit-ensure#')) {
      return commitEnsureResult === undefined ? { dirty: false, committed: false, pushed: false } : commitEnsureResult;
    }

    // 投稿系
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // journal-log: payload を pending/ へ直接書く 1 spawn（issue #807）
    if (label === 'journal-log') {
      return { saved: true, logged: true };
    }

    // pr-meta
    if (label === 'pr-meta') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
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

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

test('[terminal-telemetry] CI 経路 applied_false: fix_terminal_reason=applied_false / terminal_path=ci', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [{ status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 0, poll_attempts: 1 }],
    fixSequence: [{ applied: false, summary: 'no' }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, 'applied_false');
  assert.equal(result.terminal_path, 'ci');
});

test('[terminal-telemetry] review 経路 null_after_retry: fix_terminal_reason=null_after_retry / terminal_path=review', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }], summary: 'ng' }),
    fixSequence: [null, null],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, 'null_after_retry');
  assert.equal(result.terminal_path, 'review');
});

test('[terminal-telemetry] review 経路 commit_unensured: fix_terminal_reason=commit_unensured / terminal_path=review', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }], summary: 'ng' }),
    fixSequence: [{ applied: true, summary: 'fixed', files: [] }],
    commitEnsureResult: null,
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
  assert.equal(result.terminal_path, 'review');
});

test('[terminal-telemetry] 即 lgtm: fix_terminal_reason null / terminal_path=review / history 1 round、telemetry は merge_tier / iterate_status / review_model_config / plugin_version / plugin_commit だけ', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, null, 'lgtm 終端では fix_terminal_reason は null');
  assert.equal(result.terminal_path, 'review');
  assert.ok(Array.isArray(result.history) && result.history.length === 1, 'history は length 1 の配列であるべき');
  assert.equal(result.history[0].decision, 'approve');
  assert.deepEqual(JSON.parse(JSON.stringify(result.history[0].blocking)), []);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-log');
  assert.ok(journalCall != null, 'label===journal-log の agent 呼び出しが存在するべき');
  const telemetry = extractJournalPayload(journalCall.prompt).telemetry;
  assert.deepEqual(
    Object.keys(telemetry).sort(),
    ['iterate_status', 'merge_tier', 'plugin_commit', 'plugin_version', 'review_model_config'],
    `pr-iterate の成功 telemetry キーが想定外: ${JSON.stringify(telemetry)}`,
  );
  assert.equal(telemetry.merge_tier, 'PR_ITERATE');
  assert.equal(telemetry.iterate_status, 'lgtm');
  assert.equal(telemetry.review_model_config, 'opus', 'pr-reviewer は override 無し → frontmatter の opus');
  assert.equal(telemetry.plugin_version, PLUGIN_VERSION);
  assert.equal(telemetry.plugin_commit, null, '単体起動は prerun を経ないので plugin_commit は null');
});

test('[terminal-telemetry] CI failed→fix→passed の 2 round: history に synthetic ci:: finding / terminal_path=review', async () => {
  const { ctx } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [
      { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 0, poll_attempts: 1 },
      { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 },
    ],
    fixSequence: [{ applied: true, summary: 'fixed', files: [] }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);

  const history = result.history;
  assert.equal(history.length, 2, 'history は 2 round であるべき');
  assert.ok(history[0].blocking.length >= 1, '1 round 目の blocking は 1 件以上であるべき');
  assert.ok(history[0].blocking[0].topic.startsWith('ci::'), '1 round 目の blocking topic は ci:: で始まるべき');
  assert.equal(history[0].blocking[0].severity, 'critical');
  assert.equal(history[1].blocking.length, 0);
  assert.equal(result.terminal_path, 'review', '最終 iteration は CI passed による lgtm なので terminal_path は review であるべき');
});
