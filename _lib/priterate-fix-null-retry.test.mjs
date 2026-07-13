// F1: pr-iterate の fix===null 1回限定 retry 検証テスト（TDD red — issue #347）
// fix agent 呼び出しが null（技術的失敗）の場合のみ、同一 findings で 1 回だけ retry する。
// fix.applied===false（agent の明示判断）は retry せず即時 fix_failed。
// VM sandbox パターン（priterate-fixes-applied.test.mjs と同一構造。DRY より self-containment 優先）。

import { test } from 'node:test';
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
 * @param {Function} opts.reviewerStub - (round: number) => reviewResult  ラウンドごとの pr-reviewer 返り値
 * @param {Function} [opts.ciStub]     - (round: number) => ciResult  ラウンドごとの CI チェック返り値
 *                                        （省略時は常に { status: 'passed', failed_checks: [] }）
 * @param {Array}    [opts.fixSequence] - fix agent（'fix#' で始まる label）呼び出し順の返り値配列。
 *                                        呼び出し回数が配列長を超えたら { applied: true, summary: 'fixed' } を返す。
 * @returns {{ ctx: vm.Context, fixCalls: string[] }} fixCalls は fix agent 呼び出しの label を呼び出し順に記録した配列
 */
function makeSandbox({ reviewerStub, ciStub, fixSequence = [] }) {
  let reviewRound = 0; // pr-reviewer 呼び出し回数
  let ciRound = 0; // CI チェック呼び出し回数
  let fixCallIndex = 0; // fix agent 呼び出し回数（retry を含む）
  const fixCalls = []; // fix agent 呼び出しの label を記録（例: ['fix#1', 'fix#1-retry']）

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
      ciRound += 1;
      if (ciStub) return ciStub(ciRound);
      return { status: 'passed', failed_checks: [] };
    }

    // fix stub: label が 'fix#' で始まる（初回呼び出しも retry 呼び出しも同じ接頭辞にマッチする）
    if (label.startsWith('fix#')) {
      fixCalls.push(label);
      const idx = fixCallIndex;
      fixCallIndex += 1;
      if (idx < fixSequence.length) return fixSequence[idx];
      return { applied: true, summary: 'fixed' };
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

  return { ctx: vm.createContext(sandbox), fixCalls };
}

/**
 * pr-iterate.js を VM sandbox 上で実行し、return 値と発生エラーを返す。
 * priterate-fixes-applied.test.mjs と同一パターン。
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

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ---- テストケース ----

// (1) [blocking分岐] fix 1回目 null → retry で applied:true → round2 approve + CI passed → lgtm
test('[fix-null-retry] (1) blocking分岐: fix null → retry成功 → lgtm, fixes_applied=1, fix_null_retries=1', async () => {
  const { ctx, fixCalls } = makeSandbox({
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
    fixSequence: [null, { applied: true, summary: 'fixed' }],
  });

  const { result, error } = await runPrIterate(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fixes_applied, 1, `fixes_applied は 1 であるべきだが ${result?.fixes_applied} だった`);
  assert.deepEqual(fixCalls, ['fix#1', 'fix#1-retry'], `fix agent は 2 回（初回+retry）呼ばれるべきだが ${JSON.stringify(fixCalls)} だった`);
  assert.equal(result?.fix_null_retries, 1, `fix_null_retries は 1 であるべきだが ${result?.fix_null_retries} だった`);

  const iter1 = result?.history?.find((h) => h.iteration === 1);
  assert.ok(iter1, 'history に iteration 1 のエントリが存在するべき');
  assert.equal(iter1?.fix_retried, true, `iteration 1 の history エントリの fix_retried は true であるべきだが ${iter1?.fix_retried} だった`);
});

// (2) [blocking分岐] fix 1回目 null → retry も null → fix_failed（retry 上限 1 回固定）
test('[fix-null-retry] (2) blocking分岐: fix null → retryもnull → fix_failed, retry上限1回', async () => {
  const { ctx, fixCalls } = makeSandbox({
    reviewerStub: (_round) => ({
      decision: 'request-changes',
      issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }],
      summary: 'ng',
    }),
    fixSequence: [null, null],
  });

  const { result, error } = await runPrIterate(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(fixCalls.length, 2, `fix agent は 2 回（初回+retry 上限 1 回）だけ呼ばれるべきだが ${fixCalls.length} 回だった: ${JSON.stringify(fixCalls)}`);
  assert.equal(result?.fixes_applied, 0, `fixes_applied は 0 であるべきだが ${result?.fixes_applied} だった`);
  assert.equal(result?.fix_null_retries, 1, `fix_null_retries は 1 であるべきだが ${result?.fix_null_retries} だった`);
});

// (3) [blocking分岐] fix 1回目 applied:false → retry なし・即時 fix_failed
test('[fix-null-retry] (3) blocking分岐: fix applied:false → retryなし即時fix_failed', async () => {
  const { ctx, fixCalls } = makeSandbox({
    reviewerStub: (_round) => ({
      decision: 'request-changes',
      issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }],
      summary: 'ng',
    }),
    fixSequence: [{ applied: false, summary: 'no' }],
  });

  const { result, error } = await runPrIterate(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(fixCalls.length, 1, `fix agent は 1 回（retry なし）だけ呼ばれるべきだが ${fixCalls.length} 回だった: ${JSON.stringify(fixCalls)}`);
  assert.equal(result?.fixes_applied, 0, `fixes_applied は 0 であるべきだが ${result?.fixes_applied} だった`);
  assert.equal(result?.fix_null_retries, 0, `fix_null_retries は 0 であるべきだが ${result?.fix_null_retries} だった`);
});

// (4) [CI-failed分岐] round1 approve + CI failed → fix null → retry で applied:true → round2 approve + CI passed → lgtm
test('[fix-null-retry] (4) CI-failed分岐: fix null → retry成功 → lgtm, fix_null_retries=1', async () => {
  const { ctx, fixCalls } = makeSandbox({
    reviewerStub: (_round) => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciStub: (round) => {
      if (round === 1) {
        return { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'failure' }] };
      }
      return { status: 'passed', failed_checks: [] };
    },
    fixSequence: [null, { applied: true, summary: 'fixed' }],
  });

  const { result, error } = await runPrIterate(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.deepEqual(fixCalls, ['fix#1', 'fix#1-retry'], `fix agent は 2 回（初回+retry）呼ばれるべきだが ${JSON.stringify(fixCalls)} だった`);
  assert.equal(result?.fix_null_retries, 1, `fix_null_retries は 1 であるべきだが ${result?.fix_null_retries} だった`);
});
