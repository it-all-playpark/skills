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

function makeSandbox(journalResult, journalSaveResult) {
  let journalCallCount = 0;
  let journalSaveCallCount = 0;
  let capturedPrompt = null;
  let capturedLogPrompt = null;

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

    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る。saved:true を
    // 返して journal-log (stage2) へ進めさせる。
    if (label === 'journal-save' && agentType === 'dev-runner-haiku') {
      journalSaveCallCount += 1;
      capturedPrompt = typeof prompt === 'string' ? prompt : null;
      return journalSaveResult ?? { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }

    // journal-log (stage2): label === 'journal-log' && agentType === 'dev-runner-haiku'
    // journalResult が Error なら throw する（schema 不一致・proxy 実行失敗の再現）。
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      journalCallCount += 1;
      capturedLogPrompt = typeof prompt === 'string' ? prompt : null;
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
    getJournalSaveCallCount: () => journalSaveCallCount,
    getCapturedPrompt: () => capturedPrompt,
    getCapturedLogPrompt: () => capturedLogPrompt,
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

test('[journal-log] journalResult={logged:true} で完走 → journal-save→journal-log の 2 段呼び出しがそれぞれ 1 回、pending handoff コマンドが含まれ、result.status === lgtm', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalCallCount, getJournalSaveCallCount, getCapturedPrompt, getCapturedLogPrompt } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalSaveCallCount(),
    1,
    `journal-save dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalSaveCallCount()} 回だった`,
  );
  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );

  // issue #494: 結論値リテラル（outcome 等）と journal/pending 呼び出し語彙が同一 prompt に
  // 同居しないよう、handoff JSON の必須キーは journal-save (stage1) の prompt に載る。
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
      `journal-save prompt に '${key}' が含まれるべきだが含まれない。prompt=${capturedPrompt}`,
    );
  }

  // journal-log (stage2) は pending handoff コマンド（ファイルパスのみ）を扱い、結論値
  // リテラル（outcome 等）を含まない。
  // journal-handoff.mjs (issue #412 F3: atomic mktemp/mv write) は最終ファイル名に
  // stable effect-ID（payload sha256 先頭16hex）を含むため、旧 `priterate-5-` 直後の
  // 固定 timestamp 前提ではなく `-effect-` サフィックス付きの新命名を確認する。
  const capturedLogPrompt = getCapturedLogPrompt();
  assert.ok(
    typeof capturedLogPrompt === 'string' && capturedLogPrompt.includes('${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending/priterate-5-effect-'),
    `journal-log prompt に pending パスが含まれるべきだが含まれない。prompt=${capturedLogPrompt}`,
  );
  assert.ok(
    typeof capturedLogPrompt === 'string' && !capturedLogPrompt.includes('"outcome":"success"'),
    `journal-log prompt に結論値リテラル '"outcome":"success"' が含まれるべきではないが含まれていた。prompt=${capturedLogPrompt}`,
  );
  assert.ok(
    typeof capturedLogPrompt === 'string' && !capturedLogPrompt.includes('journal.sh log pr-iterate'),
    `journal-log prompt は direct journal.sh 実行ではなく pending handoff であるべき。prompt=${capturedLogPrompt}`,
  );

  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  // journal-log が logged:true を返すため result.journal_log_status は 3 値 closed enum のうち 'logged'
  assert.equal(
    result?.journal_log_status,
    'logged',
    `journal-log が logged:true を返す場合 result.journal_log_status は 'logged' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] journalResult={logged:false} → result が non-null で result.status === lgtm・journal_log_status === log_failed（記録失敗でも正常 return）', async () => {
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
  // journal-log が logged:false を返すため result.journal_log_status は 'log_failed'
  assert.equal(
    result?.journal_log_status,
    'log_failed',
    `journal-log が logged:false を返す場合 result.journal_log_status は 'log_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] journal-save が saved:false を返す場合 journal-log(stage2) は呼ばれず result.journal_log_status が save_failed になること', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const journalSaveResult = { saved: false };
  const { ctx, getJournalCallCount, getJournalSaveCallCount } = makeSandbox(journalResult, journalSaveResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalSaveCallCount(),
    1,
    `journal-save の呼び出しは 1 回であるべきだが ${getJournalSaveCallCount()} 回だった`,
  );
  assert.equal(
    getJournalCallCount(),
    0,
    `journal-save が saved:false を返す場合 journal-log(stage2) は呼ばれないはずだが ${getJournalCallCount()} 回呼ばれた`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-save が saved:false を返す場合 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// stage 帰属テスト: stage1 成功 → stage2 が throw した場合、失敗したのは stage2 なので
// log_failed でなければならない（save_failed に落ちると誤った診断を telemetry 利用側へ伝える）。
test('[journal-log] stage1 成功後に journal-log(stage2) が throw した場合 result.journal_log_status は log_failed（save_failed に誤帰属しない）', async () => {
  const journalResult = new Error('agent({schema}): subagent completed without calling StructuredOutput');
  const { ctx, getJournalCallCount, getJournalSaveCallCount } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(getJournalSaveCallCount(), 1);
  assert.equal(getJournalCallCount(), 1);
  // fail-open: stage2 の throw は workflow を落とさない
  assert.ok(result != null, 'journal-log(stage2) の throw で workflow が落ちてはならない（fail-open）');
  assert.equal(
    result?.journal_log_status,
    'log_failed',
    `stage2 throw 時 result.journal_log_status は 'log_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});
