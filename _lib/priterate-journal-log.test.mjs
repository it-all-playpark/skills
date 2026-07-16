// F3: pr-iterate 終端の journal-log 呼び出し検証テスト（TDD）
// 終端サマリー投稿の後・return の前に journal-log (dev-runner-haiku) が
// 1 回呼び出されること、および logged:false でも正常 return することを検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

function makeSandbox(journalResult) {
  let journalCallCount = 0;
  let capturedPrompt = null;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // pr-reviewer: 1 round で LGTM へ
    if (agentType === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    // CI チェック: agentType 'dev-runner-haiku-ro' かつ prompt に 'check-ci.sh' を含む
    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      return { status: 'passed', failed_checks: [] };
    }

    // 投稿系: label が 'post-' で始まる
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // pr-meta: repo probe（F3。issue #309）
    if (label === 'pr-meta' && agentType === 'dev-runner-haiku-ro') {
      return { url: 'https://github.com/acme/skills/pull/5' };
    }

    // journal-log: label === 'journal-log' && agentType === 'dev-runner-haiku'
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      journalCallCount += 1;
      capturedPrompt = typeof prompt === 'string' ? prompt : null;
      return journalResult;
    }

    // デフォルト
    return null;
  };

  // parallel() stub（pr-iterate では不要だが入れても無害）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // workflow() stub（pr-iterate では不要だが入れても無害）
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
    getJournalCallCount: () => journalCallCount,
    getCapturedPrompt: () => capturedPrompt,
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

test('[journal-log] journalResult={logged:true} で完走 → journal-log 呼び出し 1 回、pending handoff コマンドが含まれ、result.status === lgtm', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalCallCount, getCapturedPrompt } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );

  const capturedPrompt = getCapturedPrompt();
  const requiredKeys = [
    '~/.claude/journal/pending/priterate-5-',
    '"skill":"pr-iterate"',
    '"outcome":"success"',
    '"args":"pr=5"',
    '"repo":"acme/skills"',
    '"pr_number":5',
    '"merge_tier":"PR_ITERATE"',
    '"iterate_status":"lgtm"',
  ];
  for (const key of requiredKeys) {
    assert.ok(
      typeof capturedPrompt === 'string' && capturedPrompt.includes(key),
      `journal-log prompt に '${key}' が含まれるべきだが含まれない。prompt=${capturedPrompt}`,
    );
  }
  assert.ok(
    typeof capturedPrompt === 'string' && !capturedPrompt.includes('journal.sh log pr-iterate'),
    `journal-log prompt は direct journal.sh 実行ではなく pending handoff であるべき。prompt=${capturedPrompt}`,
  );

  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
});

test('[journal-log] journalResult={logged:false} → result が non-null で result.status === lgtm（記録失敗でも正常 return）', async () => {
  const journalResult = { logged: false, summary: 'failed' };
  const { ctx } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    result !== null && result !== undefined,
    `journal 記録失敗（logged:false）でも workflow は return object を解決するべきだが null/undefined だった`,
  );

  assert.equal(
    result?.status,
    'lgtm',
    `journal 記録失敗でも result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
});
