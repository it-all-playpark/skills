// F5: pr-iterate.js の返り値に optional end_epoch を追加する検証テスト（TDD）。
// dev-flow.js は workflow('pr-iterate') 復帰直後に隣接する agent 呼び出しを持たないため、
// pr-iterate の返り値自体に最後の ci-check 応答の epoch を end_epoch として載せる（issue #443）。
// helper（agentStub / runCapture 相当）は既存 _lib/priterate-ci-wait-telemetry.test.mjs の
// VM sandbox helper を同型コピーする（repo precedent はテストごとの helper 複製）。

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
    if (agentType === 'dev-flow:pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    // ci-check: 呼び出し順に ciResponses を消費する
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci --checks-data')) {
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

    // commit-ensure（issue #437: fix 適用直後の commit 保証。未 stub だと fail-safe で fix_failed になる）
    if (label.startsWith('commit-ensure#')) {
      return { dirty: false, committed: false, pushed: false };
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

test('[end-epoch] ci-check が epoch を返す run では返り値に end_epoch が数値で含まれる', async () => {
  const { ctx } = makeSandbox({
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1, epoch: 1753900000 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `passed で LGTM へ進むべきだが '${result?.status}' だった`);
  assert.equal(
    result?.end_epoch,
    1753900000,
    `ci-check が epoch を返した場合、返り値 end_epoch にその値が数値で反映されるべきだが ${JSON.stringify(result?.end_epoch)} だった`,
  );
});

test('[end-epoch] ci-check が epoch を返さない run では返り値に end_epoch キーが無い', async () => {
  const { ctx } = makeSandbox({
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result ?? {}, 'end_epoch'),
    `ci-check が epoch を返さない場合、返り値に end_epoch キーが存在してはいけない（fail-open）が ${JSON.stringify(result)} だった`,
  );
});

test('[end-epoch] 返り値の既存キー（status/fixes_applied/subagent_invocations）は epoch 追加の有無に関わらず不変', async () => {
  const withEpoch = makeSandbox({
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1, epoch: 1753900000 }],
  });
  const withoutEpoch = makeSandbox({
    ciResponses: [{ status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result: r1, error: e1 } = await runPrIterateCapture(src, withEpoch.ctx);
  const { result: r2, error: e2 } = await runPrIterateCapture(src, withoutEpoch.ctx);
  for (const e of [e1, e2]) {
    if (e && (e.name === 'ReferenceError' || e.name === 'SyntaxError')) {
      assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${e.name}: ${e.message}`);
    }
  }

  for (const result of [r1, r2]) {
    assert.equal(result?.status, 'lgtm');
    assert.equal(result?.fixes_applied, 0);
    assert.ok(result?.subagent_invocations != null, 'subagent_invocations は常時出力されるべき');
    assert.equal(typeof result.subagent_invocations.total, 'number');
    assert.ok(result.subagent_invocations.by_type != null);
  }
});
