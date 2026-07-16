// F3: pr-iterate の fixes_applied カウンタ検証テスト（TDD — issue #233）
// fixes_applied: fix.applied===true の累積回数。dev-flow が stale-eval 警告の判定に使う。
// VM sandbox パターン（priterate-journal-log.test.mjs と同一構造）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

/**
 * makeSandbox: テストシナリオごとにステートフル agent stub を生成する。
 *
 * @param {object} opts
 * @param {Function} opts.reviewerStub  - (round: number) => reviewResult  ラウンドごとの pr-reviewer 返り値
 * @param {object}   opts.fixResult     - fix stub の返り値（デフォルト: { applied: true, summary: 'fixed' }）
 */
function makeSandbox({ reviewerStub, fixResult = { applied: true, summary: 'fixed' } }) {
  let reviewRound = 0; // pr-reviewer 呼び出し回数

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // pr-reviewer: ラウンドをカウントしてシナリオ別の返り値を返す
    if (agentType === 'pr-reviewer') {
      reviewRound += 1;
      return reviewerStub(reviewRound);
    }

    // CI チェック: agentType 'dev-runner-haiku-ro' かつ prompt に 'check-ci.sh' を含む
    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      return { status: 'passed', failed_checks: [] };
    }

    // fix stub: label が 'fix#' で始まる
    if (label.startsWith('fix#')) {
      return fixResult;
    }

    // 投稿系: label が 'post-' で始まる
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // journal-log
    if (label === 'journal-log') {
      return { logged: true, summary: '' };
    }

    // デフォルト
    return null;
  };

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

/**
 * pr-iterate.js を VM sandbox 上で実行し、return 値と発生エラーを返す。
 * priterate-journal-log.test.mjs と同一パターン。
 */
async function runPrIterate(src, ctx) {
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

// ---- テストケース ----

// (A) round 1 から approve + CI passed → fixes_applied === 0、status === 'lgtm'、iterations === 1
test('[fixes_applied] (A) round 1 approve → fixes_applied === 0, status === lgtm, iterations === 1', async () => {
  const ctx = makeSandbox({
    reviewerStub: (_round) => ({ decision: 'approve', issues: [], summary: 'ok' }),
  });

  const { result, error } = await runPrIterate(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 1, `iterations は 1 であるべきだが ${result?.iterations} だった`);
  assert.equal(result?.fixes_applied, 0, `fixes_applied は 0 であるべきだが ${result?.fixes_applied} だった`);
});

// (B) round 1 request_changes → fix applied:true → round 2 approve + CI passed
//     → fixes_applied === 1、status === 'lgtm'、iterations === 2
test('[fixes_applied] (B) round 1 request_changes → fix → round 2 approve → fixes_applied === 1, status === lgtm', async () => {
  const ctx = makeSandbox({
    reviewerStub: (round) => {
      if (round === 1) {
        return {
          decision: 'request-changes',
          issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }],
          summary: 'ng',
        };
      }
      return { decision: 'approve', issues: [], summary: 'ok' };
    },
    fixResult: { applied: true, summary: 'fixed' },
  });

  const { result, error } = await runPrIterate(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 2, `iterations は 2 であるべきだが ${result?.iterations} だった`);
  assert.equal(result?.fixes_applied, 1, `fixes_applied は 1 であるべきだが ${result?.fixes_applied} だった`);
});

// (C) round 1 request_changes → fix applied:false → status === 'fix_failed'、fixes_applied === 0
test('[fixes_applied] (C) round 1 request_changes → fix applied:false → status === fix_failed, fixes_applied === 0', async () => {
  const ctx = makeSandbox({
    reviewerStub: (_round) => ({
      decision: 'request-changes',
      issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }],
      summary: 'ng',
    }),
    fixResult: { applied: false, summary: 'no' },
  });

  const { result, error } = await runPrIterate(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fixes_applied, 0, `fixes_applied は 0 であるべきだが ${result?.fixes_applied} だった`);
});

// (D) return オブジェクトに fixes_applied キーが number 型で常に存在する
test('[fixes_applied] (D) return に fixes_applied が number 型で常に存在する', async () => {
  const ctx = makeSandbox({
    reviewerStub: (_round) => ({ decision: 'approve', issues: [], summary: 'ok' }),
  });

  const { result, error } = await runPrIterate(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(result !== null && result !== undefined, 'result は non-null であるべき');
  assert.equal(
    typeof result?.fixes_applied,
    'number',
    `fixes_applied は number 型であるべきだが typeof = '${typeof result?.fixes_applied}' だった`,
  );
});
