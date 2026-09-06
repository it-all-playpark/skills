// F3: pr-iterate.js の新規 telemetry キー 5 種（terminal_path / fix_terminal_reason /
// quality_model_config / plugin_version / iterate_history）を journal-save payload へ配線する
// 検証テスト（TDD）。issue #601。
// telemetryHandoff（journal-save prompt に verbatim 転写される payload）から
// <<<JOURNAL_HANDOFF_BODY_BEGIN>>> / <<<JOURNAL_HANDOFF_BODY_END>>> の間を JSON.parse して
// .telemetry を検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { QUALITY_MODEL } from './quality-model.mjs';
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

    // journal-save (stage1)
    if (label === 'journal-save') {
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    // journal-log (stage2)
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
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

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  const payload = extractJournalPayload(journalCall.prompt);
  assert.equal(payload.telemetry.fix_terminal_reason, 'applied_false');
  assert.equal(payload.telemetry.terminal_path, 'ci');
});

test('[terminal-telemetry] review 経路 null_after_retry: fix_terminal_reason=null_after_retry / terminal_path=review', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }], summary: 'ng' }),
    fixSequence: [null, null],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  const payload = extractJournalPayload(journalCall.prompt);
  assert.equal(payload.telemetry.fix_terminal_reason, 'null_after_retry');
  assert.equal(payload.telemetry.terminal_path, 'review');
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

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  const payload = extractJournalPayload(journalCall.prompt);
  assert.equal(payload.telemetry.fix_terminal_reason, 'commit_unensured');
  assert.equal(payload.telemetry.terminal_path, 'review');
});

test('[terminal-telemetry] 即 lgtm: fix_terminal_reason キー欠落 / terminal_path=review / quality_model_config / plugin_version / iterate_history', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  const payload = extractJournalPayload(journalCall.prompt);
  const telemetry = payload.telemetry;

  assert.equal(Object.hasOwn(telemetry, 'fix_terminal_reason'), false, 'lgtm 終端では fix_terminal_reason キーが欠落するべき');
  assert.equal(telemetry.terminal_path, 'review');
  assert.equal(telemetry.quality_model_config, QUALITY_MODEL);

  const pluginJson = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(telemetry.plugin_version, PLUGIN_VERSION);
  assert.equal(telemetry.plugin_version, pluginJson.version);

  assert.ok(Array.isArray(telemetry.iterate_history) && telemetry.iterate_history.length === 1, 'iterate_history は length 1 の配列であるべき');
  assert.equal(telemetry.iterate_history[0].decision, 'approve');
  assert.deepEqual(telemetry.iterate_history[0].blocking, []);
});

test('[terminal-telemetry] CI failed→fix→passed の 2 round: iterate_history に synthetic ci:: finding / terminal_path=review', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
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

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  const payload = extractJournalPayload(journalCall.prompt);
  const telemetry = payload.telemetry;

  assert.equal(telemetry.iterate_history.length, 2, 'iterate_history は 2 round であるべき');
  assert.ok(telemetry.iterate_history[0].blocking.length >= 1, '1 round 目の blocking は 1 件以上であるべき');
  assert.ok(telemetry.iterate_history[0].blocking[0].topic.startsWith('ci::'), '1 round 目の blocking topic は ci:: で始まるべき');
  assert.equal(telemetry.iterate_history[0].blocking[0].severity, 'critical');
  assert.deepEqual(telemetry.iterate_history[1].blocking, []);
  assert.equal(telemetry.terminal_path, 'review', '最終 iteration は CI passed による lgtm なので terminal_path は review であるべき');
});

test('[terminal-telemetry] result.terminal_path と telemetry.terminal_path が一致する', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  const payload = extractJournalPayload(journalCall.prompt);

  assert.equal(result?.terminal_path, payload.telemetry.terminal_path, '返り値と telemetry payload の terminal_path は一致するべき');
});
