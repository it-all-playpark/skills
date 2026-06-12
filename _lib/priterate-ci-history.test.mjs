// F1: CI-failed ラウンドが history と per-round 投稿に反映されることを pin する TDD テスト（red phase）
// アサーション:
//   (1) label==='post-review#1' の agent 呼び出しが存在し、prompt に 'CI check failed: bats' が含まれる
//   (2) label==='post-summary' の prompt に '反復履歴' が含まれ、iter 1 行と iter 2 行が両方含まれる
//   (3) post-summary の prompt に 'CI check failed: bats' が含まれる（全 blocking 詳細 details セクション経由）
//   (4) result.status === 'lgtm' かつ result.iterations === 2
//   (5) ReferenceError/SyntaxError での sandbox クラッシュは assert.fail

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

function makeSandbox() {
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

    // ci-check: 1 回目は failed、2 回目は passed
    if (agentType === 'dev-runner' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      ciCallCount += 1;
      if (ciCallCount === 1) {
        return {
          status: 'failed',
          failed_checks: [{ name: 'bats', bucket: 'test', state: 'failure' }],
        };
      }
      return { status: 'passed', failed_checks: [] };
    }

    // fix: label が 'fix#' で始まる
    if (label.startsWith('fix#')) {
      return { applied: true, summary: 'fixed', files: [] };
    }

    // post 系: label が 'post-' で始まる
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

test('[ci-history] CI-failed ラウンドが per-round コメントと終端レポートに反映される', async () => {
  const { ctx, getAgentCalls } = makeSandbox();

  const { result, error } = await runPrIterateCapture(src, ctx);

  // (5) sandbox クラッシュ検出
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const agentCalls = getAgentCalls();

  // (1) label==='post-review#1' の呼び出しが存在し、prompt に 'CI check failed: bats' が含まれる
  // CI-failed ラウンド（iteration 1）の per-round コメント投稿の検証
  const postReview1 = agentCalls.find((c) => c.label === 'post-review#1');
  assert.ok(
    postReview1 != null,
    `label==='post-review#1' の agent 呼び出しが存在するべきだが見つからなかった。呼び出しラベル一覧: ${agentCalls.map((c) => c.label).join(', ')}`,
  );
  assert.ok(
    typeof postReview1.prompt === 'string' && postReview1.prompt.includes('CI check failed: bats'),
    `post-review#1 の prompt に 'CI check failed: bats' が含まれるべきだが含まれない。\nprompt の先頭500文字: ${String(postReview1?.prompt ?? '').slice(0, 500)}`,
  );

  // (2) post-summary の prompt に '反復履歴' と '| 1 |' と '| 2 |' が含まれる
  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(
    postSummary != null,
    `label==='post-summary' の agent 呼び出しが存在するべきだが見つからなかった。呼び出しラベル一覧: ${agentCalls.map((c) => c.label).join(', ')}`,
  );
  assert.ok(
    typeof postSummary.prompt === 'string' && postSummary.prompt.includes('反復履歴'),
    `post-summary の prompt に '反復履歴' が含まれるべきだが含まれない。\nprompt の先頭500文字: ${String(postSummary?.prompt ?? '').slice(0, 500)}`,
  );
  assert.ok(
    typeof postSummary.prompt === 'string' && postSummary.prompt.includes('| 1 |'),
    `post-summary の prompt に '| 1 |'（iter 1 の行）が含まれるべきだが含まれない。\nprompt の先頭800文字: ${String(postSummary?.prompt ?? '').slice(0, 800)}`,
  );
  assert.ok(
    typeof postSummary.prompt === 'string' && postSummary.prompt.includes('| 2 |'),
    `post-summary の prompt に '| 2 |'（iter 2 の行）が含まれるべきだが含まれない。\nprompt の先頭800文字: ${String(postSummary?.prompt ?? '').slice(0, 800)}`,
  );

  // (3) post-summary の prompt に 'CI check failed: bats' が含まれる（全 blocking 詳細 details セクション経由）
  assert.ok(
    typeof postSummary.prompt === 'string' && postSummary.prompt.includes('CI check failed: bats'),
    `post-summary の prompt に 'CI check failed: bats' が含まれるべきだが含まれない（全 blocking 詳細 details セクション）。\nprompt の先頭1000文字: ${String(postSummary?.prompt ?? '').slice(0, 1000)}`,
  );

  // (4) result.status === 'lgtm' かつ result.iterations === 2
  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  assert.equal(
    result?.iterations,
    2,
    `result.iterations は 2 であるべきだが ${result?.iterations} だった`,
  );
});
