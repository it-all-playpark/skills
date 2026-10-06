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
  const labels = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    labels.push(label);

    // pr-reviewer: 1 round で LGTM へ
    if (agentType === 'dev-flow:pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    // CI チェック: agentType 'dev-runner-haiku-ro' かつ prompt に 'check-ci.sh' を含む
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci --checks-data')) {
      return { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
    }

    // 投稿系: label が 'post-' で始まる
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // pr-meta: repo probe（F3。issue #309）
    if (label === 'pr-meta' && agentType === 'dev-flow:dev-runner-haiku-ro') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
    }

    // journal-log: 実際の telemetry payload はここに載り、pending/ へ直接書く 1 spawn（issue #807）。
    // journalResult が Error なら throw する（schema 不一致・proxy 実行失敗の再現）。
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      journalCallCount += 1;
      capturedPrompt = typeof prompt === 'string' ? prompt : null;
      if (journalResult instanceof Error) throw journalResult;
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
    getLabels: () => labels,
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

test('[journal-log] journalResult={saved:true, logged:true} で完走 → journal-log が 1 spawn だけ呼ばれ、payload と pending パスを含み、result.status === lgtm', async () => {
  const journalResult = { saved: true, logged: true };
  const { ctx, getJournalCallCount, getCapturedPrompt, getLabels } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );
  assert.ok(!getLabels().includes('journal-save'), `payload の一時ファイルを書く journal-save spawn は起動しない: ${getLabels().join(', ')}`);

  const capturedPrompt = getCapturedPrompt();
  const requiredKeys = [
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

  // journal-handoff.mjs は最終ファイル名に stable effect-ID（payload 由来の 16hex）を含む。
  // issue #526 で shell を外したため、pending パスは shell 展開式ではなく Write tool が展開する `~` 形。
  assert.ok(
    typeof capturedPrompt === 'string' && capturedPrompt.includes('~/.claude/journal/pending/priterate-5-effect-'),
    `journal-log prompt に pending パスが含まれるべきだが含まれない。prompt=${capturedPrompt}`,
  );
  assert.ok(
    typeof capturedPrompt === 'string' && !capturedPrompt.includes('.devflow-tmp'),
    `journal-log prompt は payload の一時ファイルを経由してはならない。prompt=${capturedPrompt}`,
  );
  assert.ok(
    typeof capturedPrompt === 'string' && !capturedPrompt.includes('journal log pr-iterate'),
    `journal-log prompt は direct journal 実行ではなく pending handoff であるべき。prompt=${capturedPrompt}`,
  );

  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  // journal-log が {saved:true, logged:true} を返すため result.journal_log_status は 3 値 closed enum のうち 'logged'
  assert.equal(
    result?.journal_log_status,
    'logged',
    `journal-log が logged:true を返す場合 result.journal_log_status は 'logged' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] journalResult={saved:true, logged:false} → result が non-null で result.status === lgtm・journal_log_status === log_failed（記録失敗でも正常 return）', async () => {
  const journalResult = { saved: true, logged: false };
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
  // Write を試みて失敗した申告なので result.journal_log_status は 'log_failed'
  assert.equal(
    result?.journal_log_status,
    'log_failed',
    `journal-log が saved:true / logged:false を返す場合 result.journal_log_status は 'log_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] journal-log が saved:false を返す場合 result.journal_log_status が save_failed になること', async () => {
  const journalResult = { saved: false, logged: false };
  const { ctx, getJournalCallCount } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-log が saved:false を返す場合 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// journal-log が throw した場合は Write 到達の申告が無いので journalLogStatus は初期値 'save_failed'
// のまま run が継続する（fail-open）。
test('[journal-log] journal-log が throw した場合 result.journal_log_status は save_failed のまま run 完走する（fail-open）', async () => {
  // issue #527/#533: trackedAgent のリトライは `opts.retryOnContractViolation === true` の
  // opt-in call site 限定で、journal-log の call site は opt-in していない
  // ため 'without calling StructuredOutput' を含む throw でもリトライされない。ここでは
  // 意図を明確にするため exec-proxy 実行失敗を示す別メッセージ（call count=1 想定に影響しない）を使う。
  const journalResult = new Error('exec-proxy 実行失敗: EPERM');
  const { ctx, getJournalCallCount } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(getJournalCallCount(), 1);
  assert.ok(result != null, 'journal-log の throw で workflow が落ちてはならない（fail-open）');
  assert.equal(
    result?.status,
    'lgtm',
    `journal-log throw でも result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-log throw 時 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// inline 区間整合: journal handoff の choreography は canonical（_lib/journal-handoff.mjs）の inline 区間にのみ
// 存在し、call site 側に手写しが残っていないこと（否定 pin）。call site の label（journal-log）と
// handoff の挙動は上の VM テストと exec-proxy-routing.test.mjs が観測する。
test('[journal-log] inline 整合: pr-iterate.js の inline 区間外に journal handoff choreography の手写しが残っていない', () => {
  const anchor = src.indexOf('==== END inline: _lib/journal-handoff.mjs ====');
  assert.ok(anchor >= 0, 'journal-handoff inline END marker が見つからない');
  assert.equal(src.indexOf("let journalLogStatus = 'save_failed'", anchor + 1), -1, 'inline 区間外に手写し choreography（journalLogStatus 初期化）が残っている');
});
