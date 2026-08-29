// F1: pr-iterate 単体起動 run の journal telemetry に iterate_rounds / fixes_applied を
// 載せる配線の検証テスト（TDD）。issue #535。
// telemetryHandoff（journal-save prompt に verbatim 転写される payload）に
// iterate_rounds（= Math.min(i, MAX)）/ fixes_applied（= fixesApplied）が
// 追加されていることを、journal-save agent 呼び出しの prompt 文字列から検証する。

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

    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') {
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    // journal-log (stage2)
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }

    // commit-ensure（issue #437: fix 適用直後の commit 保証。未 stub だと fail-safe で fix_failed になる）
    if (label.startsWith('commit-ensure#')) {
      return { dirty: false, committed: false, pushed: false };
    }

    // pr-meta: cwd は実 run では常に worktree の絶対パス。journal-save の保存先はここから組み立てられる。
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

test('[iterate-telemetry] AC: failed→fix→passed の 2 iteration run で journal-save prompt に iterate_rounds:2 / fixes_applied:1 が載る', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    ciResponses: [
      { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 0, poll_attempts: 1 },
      { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 },
    ],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `2 回目の CI check で passed になり LGTM へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.fixes_applied, 1, `result.fixes_applied は 1 であるべきだが ${result?.fixes_applied} だった`);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  assert.ok(
    journalCall.prompt.includes('"iterate_rounds":2'),
    `journal-save prompt に "iterate_rounds":2 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    journalCall.prompt.includes('"fixes_applied":1'),
    `journal-save prompt に "fixes_applied":1 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1200)}`,
  );
});

test('[iterate-telemetry] AC: 即 lgtm（1 iteration・fix 0 回）の run で journal-save prompt に iterate_rounds:1 / fixes_applied:0 が載る', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `即 approve + CI passed で LGTM へ進むべきだが '${result?.status}' だった`);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, 'label===journal-save の agent 呼び出しが存在するべき');
  assert.ok(
    journalCall.prompt.includes('"iterate_rounds":1'),
    `journal-save prompt に "iterate_rounds":1 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1200)}`,
  );
  assert.ok(
    journalCall.prompt.includes('"fixes_applied":0'),
    `journal-save prompt に "fixes_applied":0 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1200)}`,
  );
});
