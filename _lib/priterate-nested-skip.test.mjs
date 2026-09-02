// issue #550 案3: dev-flow → workflow('pr-iterate') の nested 起動時に pr-meta / isolation-cleanup
// probe を skip する検証テスト（TDD）。priterate-isolation-wiring.test.mjs の VM sandbox パターン
// （makeSandbox/runPrIterateCapture）を踏襲し pr-iterate.js を実際に VM 実行して検証する。
// isolation-probe は両モード（nested / 単体起動）で不変に実行されることも併せて pin する。

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

function makeSandbox({ args, isolationProbeResult = { written: true } }) {
  const labels = [];
  let isolationProbePrompt = null;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    labels.push(label);

    if (label === 'isolation-probe' && agentType === 'dev-runner-haiku-wo') {
      isolationProbePrompt = prompt;
      return isolationProbeResult;
    }

    if (agentType === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    if (label.startsWith('fix#')) {
      return { applied: true, files: [], summary: 'fixed' };
    }

    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci --checks-data')) {
      return { status: 'passed', failed_checks: [] };
    }

    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    if (label === 'pr-meta' && agentType === 'dev-runner-haiku-ro') {
      return { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt', epoch: 999 };
    }

    if (label === 'isolation-cleanup') {
      return { cleaned: true };
    }

    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }

    // デフォルト（未知 label は null。fail-open 前提）
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
    args,
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
    labels,
    getIsolationProbePrompt: () => isolationProbePrompt,
  };
}

async function runPrIterateCapture(source, ctx) {
  const stripped = source
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

test('[nested] pr-meta / isolation-cleanup を skip し isolation-probe のみ実行する', async () => {
  const { ctx, labels, getIsolationProbePrompt } = makeSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: { cwd: '/wt', head_ref: 'feature/issue-1', repo: 'o/r', epoch: 1234 } },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `nested 起動は throw されるべきではないが error=${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
  assert.ok(!labels.includes('pr-meta'), 'nested 起動では pr-meta が呼ばれてはいけない');
  assert.ok(!labels.includes('isolation-cleanup'), 'nested 起動では isolation-cleanup が呼ばれてはいけない');
  assert.ok(labels.includes('isolation-probe'), 'nested 起動でも isolation-probe は呼ばれるべき');
  assert.match(
    String(getIsolationProbePrompt() ?? ''),
    /\.devflow-tmp\/\.isolation-probe-1234/,
    'isolation-probe の対象パスに nested.epoch(1234) が使われていない',
  );
});

test('[nested] nested.epoch 省略時は isoToken が PR 番号へ fallback する', async () => {
  const { ctx, getIsolationProbePrompt } = makeSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: { cwd: '/wt', head_ref: 'feature/issue-1' } },
  });

  const { error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `nested 起動（epoch 省略）は throw されるべきではないが error=${error?.message}`);
  assert.match(
    String(getIsolationProbePrompt() ?? ''),
    /\.devflow-tmp\/\.isolation-probe-7/,
    'nested.epoch 省略時、isoToken は PR 番号(7)へ fallback するべき',
  );
});

test('[単体起動] pr-meta / isolation-cleanup / isolation-probe の 3 つが全て呼ばれる', async () => {
  const { ctx, labels } = makeSandbox({ args: '5' });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `単体起動は throw されるべきではないが error=${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
  assert.ok(labels.includes('pr-meta'), '単体起動では pr-meta が呼ばれるべき');
  assert.ok(labels.includes('isolation-cleanup'), '単体起動では isolation-cleanup が呼ばれるべき');
  assert.ok(labels.includes('isolation-probe'), '単体起動では isolation-probe が呼ばれるべき');
});

test('[nested] 不正形（cwd 欠落）は明示 throw する', async () => {
  const { ctx } = makeSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: { head_ref: 'feature/issue-1' } },
  });

  const { error } = await runPrIterateCapture(src, ctx);

  assert.ok(error != null, 'nested.cwd 欠落は throw されるべき');
});

test('[nested] 不正形（非 object）は明示 throw する', async () => {
  const { ctx } = makeSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: 'not-an-object' },
  });

  const { error } = await runPrIterateCapture(src, ctx);

  assert.ok(error != null, 'nested が非 object の場合は throw されるべき');
});
