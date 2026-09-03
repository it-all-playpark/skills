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
    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci --checks-data')) {
      return { status: 'passed', failed_checks: [] };
    }

    // 投稿系: label が 'post-' で始まる
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // pr-meta: repo probe（F3。issue #309）
    // cwd は実 run では常に worktree の絶対パス。journal-save の保存先はここから組み立てられる。
    if (label === 'pr-meta' && agentType === 'dev-runner-haiku-ro') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
    }

    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る。saved:true を
    // 返して journal-log (stage2) へ進めさせる。journalSaveResult が Error なら throw する
    // （stage1 の proxy 実行失敗・schema 不一致の再現。issue #499 F4）。
    if (label === 'journal-save' && agentType === 'dev-runner-haiku') {
      journalSaveCallCount += 1;
      capturedPrompt = typeof prompt === 'string' ? prompt : null;
      if (journalSaveResult instanceof Error) throw journalSaveResult;
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
  // journal-handoff.mjs は最終ファイル名に stable effect-ID（payload 由来の 16hex）を含む。
  // issue #526 で stage2 から shell を外したため、pending パスは shell 展開式ではなく
  // Write tool が展開する `~` 形になっている。
  const capturedLogPrompt = getCapturedLogPrompt();
  assert.ok(
    typeof capturedLogPrompt === 'string' && capturedLogPrompt.includes('~/.claude/journal/pending/priterate-5-effect-'),
    `journal-log prompt に pending パスが含まれるべきだが含まれない。prompt=${capturedLogPrompt}`,
  );
  assert.ok(
    typeof capturedLogPrompt === 'string' && !capturedLogPrompt.includes('"outcome":"success"'),
    `journal-log prompt に結論値リテラル '"outcome":"success"' が含まれるべきではないが含まれていた。prompt=${capturedLogPrompt}`,
  );
  assert.ok(
    typeof capturedLogPrompt === 'string' && !capturedLogPrompt.includes('journal log pr-iterate'),
    `journal-log prompt は direct journal 実行ではなく pending handoff であるべき。prompt=${capturedLogPrompt}`,
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
  // issue #527/#533: trackedAgent のリトライは `opts.retryOnContractViolation === true` の
  // opt-in call site 限定で、journal-save/journal-log の call site はいずれも opt-in していない
  // ため 'without calling StructuredOutput' を含む throw でもリトライされない。ここでは
  // 意図を明確にするため exec-proxy 実行失敗を示す別メッセージ（call count=1 想定に影響しない）を使う。
  const journalResult = new Error('exec-proxy 実行失敗: EPERM');
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

// issue #499 F4: stage1（journal-save）が throw した場合は journal-log(stage2) が呼ばれる前に
// 外側 catch へ抜けるため、journalLogStatus は初期値 'save_failed' のまま run が継続する（fail-open）。
// stage2 が何らかの理由で失敗した場合も journal_log_status は 'log_failed'、stage1 で落ちた
// 場合は 'save_failed' として観測可能なまま run に影響しない（どの段で落ちたかが返り値に残る）。
test('[journal-log] stage1 の journal-save(agent) が throw した場合 journal-log(stage2) は呼ばれず result.journal_log_status は save_failed のまま run 完走する（fail-open）', async () => {
  // issue #527/#533: trackedAgent のリトライは `opts.retryOnContractViolation === true` の
  // opt-in call site 限定で、journal-save/journal-log の call site はいずれも opt-in していない
  // ため 'without calling StructuredOutput' を含む throw でもリトライされない。ここでは
  // 意図を明確にするため exec-proxy 実行失敗を示す別メッセージ（call count=1 想定に影響しない）を使う。
  const journalSaveResult = new Error('exec-proxy 実行失敗: EPERM');
  const { ctx, getJournalCallCount, getJournalSaveCallCount } = makeSandbox({ logged: true, summary: 'ok' }, journalSaveResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(getJournalSaveCallCount(), 1);
  assert.equal(
    getJournalCallCount(),
    0,
    `journal-save(stage1) が throw する場合 journal-log(stage2) は呼ばれないはずだが ${getJournalCallCount()} 回呼ばれた`,
  );
  assert.ok(result != null, 'journal-save(stage1) の throw で workflow が落ちてはならない（fail-open）');
  assert.equal(
    result?.status,
    'lgtm',
    `stage1 throw でも result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `stage1 throw 時 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] source pin: 終端の journal handoff は inline 区間外の call site が runJournalHandoff を呼び、logLabel は journal-log のまま（choreography の手写しが残っていない）', () => {
  const anchor = src.indexOf('==== END inline: _lib/journal-handoff.mjs ====');
  assert.ok(anchor >= 0, 'journal-handoff inline END marker が見つからない');
  const callIdx = src.indexOf('runJournalHandoff({', anchor);
  assert.ok(callIdx > anchor, 'inline 区間より後（call site）に runJournalHandoff 呼び出しが無い');
  const labelIdx = src.indexOf("logLabel: 'journal-log',", callIdx);
  assert.ok(labelIdx > callIdx, "call site の logLabel が現行値 'journal-log' でない");
  assert.equal(src.indexOf("let journalLogStatus = 'save_failed'", anchor + 1), -1, 'inline 区間外に手写し choreography（journalLogStatus 初期化）が残っている');
});
