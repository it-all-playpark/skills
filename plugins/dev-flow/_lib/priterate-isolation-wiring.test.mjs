// F1 (issue #449): pr-iterate.js の review loop 進入前に isolation-probe を配線する検証テスト（TDD）。
// dev-flow.js の Setup phase 配線（_lib/isolation-probe-wiring.test.mjs）と同型だが、pr-iterate では
// review loop 進入前（fix stage 不到達の保証）に probe を置く点が異なる。純関数
// （isolationProbePrompt/isolationFailureMessage）自体は _lib/isolation-probe.test.mjs でテスト済み。
//
// issue #636: 従来 (a) にあった pr-iterate.js ソース文字列の regex 走査（関数本体・行順序・schema
// 宣言・log 文言 pin）を、VM 実行による挙動検証（agentType/呼び出し順序/prompt データ echo/
// fail-open・fail-closed 分岐）へ置換した。inline 区間の全文整合は _lib/workflow-inlines.sync.test.mjs
// が別途保証するため本ファイルの対象外。
// 本ファイルは VM 実行による written:false→throw / written:true→lgtm 完走 / null→fail-open 完走の
// 3 分岐と、isolation-probe/isolation-cleanup/pr-meta の配線挙動を検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { ISOLATION_PROBE_CLEANUP_GLOB } from './isolation-probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

// ---- VM 実行 harness ----
// priterate-journal-log.test.mjs の makeSandbox/runPrIterateCapture パターンを流用し、
// agent() 呼び出し全件を calls 配列（{label, agentType, prompt}）へ記録するよう拡張する。

function makeSandbox({ isolationProbeResult, journalResult, isolationCleanupResult, prMetaResult } = {}) {
  let reviewerCallCount = 0;
  let fixCallCount = 0;
  let isolationProbeCallCount = 0;
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: prompt ?? '' });

    if (label === 'isolation-probe' && agentType === 'dev-flow:dev-runner-haiku-wo') {
      isolationProbeCallCount += 1;
      return isolationProbeResult;
    }

    if (label === 'isolation-cleanup' && agentType === 'dev-flow:dev-runner-haiku') {
      return isolationCleanupResult ?? null;
    }

    if (agentType === 'dev-flow:pr-reviewer') {
      reviewerCallCount += 1;
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    if (label.startsWith('fix#')) {
      fixCallCount += 1;
      return { applied: true, files: [], summary: 'fixed' };
    }

    if (agentType === 'dev-flow:dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci --checks-data')) {
      return { status: 'passed', failed_checks: [] };
    }

    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    if (label === 'pr-meta' && agentType === 'dev-flow:dev-runner-haiku-ro') {
      return prMetaResult ?? { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt' };
    }

    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return journalResult ?? { logged: true, summary: 'ok' };
    }

    // デフォルト（未知 label は null。dev-flow Setup probe / 既存 priterate テスト群と同じ fail-open 前提）
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
    calls,
    getReviewerCallCount: () => reviewerCallCount,
    getFixCallCount: () => fixCallCount,
    getIsolationProbeCallCount: () => isolationProbeCallCount,
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

// ---- (i) 呼び出し順序: pr-meta < isolation-cleanup < isolation-probe < 最初の pr-reviewer 呼び出し ----

test('[isolation-wiring] pr-meta → isolation-cleanup → isolation-probe → 最初の pr-reviewer 呼び出しの順に実行される', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true } });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);

  const labels = calls.map((c) => c.label);
  const metaIdx = labels.indexOf('pr-meta');
  const cleanupIdx = labels.indexOf('isolation-cleanup');
  const probeIdx = labels.indexOf('isolation-probe');
  const reviewerIdx = calls.findIndex((c) => c.agentType === 'dev-flow:pr-reviewer');

  assert.notStrictEqual(metaIdx, -1, 'pr-meta 呼び出しが記録されていない');
  assert.notStrictEqual(cleanupIdx, -1, 'isolation-cleanup 呼び出しが記録されていない');
  assert.notStrictEqual(probeIdx, -1, 'isolation-probe 呼び出しが記録されていない');
  assert.notStrictEqual(reviewerIdx, -1, 'pr-reviewer 呼び出しが記録されていない');

  assert.ok(metaIdx < cleanupIdx, 'pr-meta は isolation-cleanup より前に呼ばれるべき');
  assert.ok(cleanupIdx < probeIdx, 'isolation-cleanup は isolation-probe より前に呼ばれるべき');
  assert.ok(probeIdx < reviewerIdx, 'isolation-probe は最初の pr-reviewer 呼び出しより前に呼ばれるべき（review loop 進入前）');
});

// ---- (ii) agentType が namespaced 形（dev-flow:<name>）で正しく割り当てられている ----

test('[isolation-wiring] isolation-probe/isolation-cleanup/pr-meta の agentType が期待どおりの namespaced id である', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true } });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const probeCall = calls.find((c) => c.label === 'isolation-probe');
  const cleanupCall = calls.find((c) => c.label === 'isolation-cleanup');
  const metaCall = calls.find((c) => c.label === 'pr-meta');

  assert.ok(probeCall, 'isolation-probe 呼び出しが記録されていない');
  assert.ok(cleanupCall, 'isolation-cleanup 呼び出しが記録されていない');
  assert.ok(metaCall, 'pr-meta 呼び出しが記録されていない');

  assert.equal(probeCall.agentType, 'dev-flow:dev-runner-haiku-wo', 'isolation-probe の agentType が期待と異なる');
  assert.equal(cleanupCall.agentType, 'dev-flow:dev-runner-haiku', 'isolation-cleanup の agentType が期待と異なる');
  assert.equal(metaCall.agentType, 'dev-flow:dev-runner-haiku-ro', 'pr-meta の agentType が期待と異なる');
});

// ---- (iii) isoToken: pr-meta の epoch → probe path token（fallback は PR 番号） ----

test('[isolation-wiring] pr-meta が epoch を返した場合、isolation-probe の prompt が同 epoch を token として含む', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: true },
    prMetaResult: { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt', epoch: 999 },
  });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const probeCall = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(probeCall, 'isolation-probe 呼び出しが記録されていない');
  assert.ok(
    probeCall.prompt.includes('.isolation-probe-999'),
    `pr-meta の epoch(999) が isoToken として probe path に反映されるべき。prompt: ${probeCall.prompt.slice(0, 400)}`,
  );
});

test('[isolation-wiring] pr-meta が epoch を返さない場合、isolation-probe の prompt は PR 番号(5)へ fallback した token を含む', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: true },
    prMetaResult: { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt' },
  });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const probeCall = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(probeCall, 'isolation-probe 呼び出しが記録されていない');
  assert.ok(
    probeCall.prompt.includes('.isolation-probe-5'),
    `pr-meta が epoch を返さない場合、isoToken は PR 番号(5)へ fallback するべき。prompt: ${probeCall.prompt.slice(0, 400)}`,
  );
});

// ---- (iv) isolation-cleanup の除去対象は ISOLATION_PROBE_CLEANUP_GLOB のみ（.devflow-tmp 全体ではない） ----

test('[isolation-wiring] isolation-cleanup prompt は ISOLATION_PROBE_CLEANUP_GLOB のみを対象にし、.devflow-tmp 全体は対象にしない', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true } });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const cleanupCall = calls.find((c) => c.label === 'isolation-cleanup');
  assert.ok(cleanupCall, 'isolation-cleanup 呼び出しが記録されていない');
  assert.ok(
    cleanupCall.prompt.includes(`git -C /tmp/wt clean -fdx -- ${ISOLATION_PROBE_CLEANUP_GLOB}`),
    `cleanup コマンドが ISOLATION_PROBE_CLEANUP_GLOB（${ISOLATION_PROBE_CLEANUP_GLOB}）を対象にするべき。prompt: ${cleanupCall.prompt.slice(0, 400)}`,
  );
  assert.ok(
    !cleanupCall.prompt.includes('clean -fdx -- .devflow-tmp`'),
    'pr-iterate の cleanup 対象は .devflow-tmp 全体になってはならない（glob 限定 — issue #555）',
  );
});

// ---- (v) isolation-cleanup の失敗は fail-open（probe に到達し lgtm 完走する） ----

test('[isolation-wiring] isolation-cleanup が {cleaned:false} を返しても fail-open で isolation-probe に到達し lgtm 完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: true },
    isolationCleanupResult: { cleaned: false, error: 'cleanup denied' },
  });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, 'isolation-cleanup 失敗（cleaned:false）で throw してはならない（fail-open）');
  assert.equal(getIsolationProbeCallCount(), 1, 'cleanup 失敗後も isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

test('[isolation-wiring] isolation-cleanup が null（agent 失敗）でも fail-open で isolation-probe に到達し lgtm 完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: true },
    isolationCleanupResult: null,
  });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, 'isolation-cleanup が null（agent 失敗）で throw してはならない（fail-open）');
  assert.equal(getIsolationProbeCallCount(), 1, 'cleanup 失敗後も isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

// ---- (vi) written:false の throw メッセージ contract（識別子・startRef） ----

test('[isolation-wiring] written:false の throw メッセージは pr-iterate / args(5) / EnterWorktree を含み dev-flow を指さない', async () => {
  const { ctx, getReviewerCallCount, getFixCallCount, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: false, error: 'Write denied by bg-isolation guard' },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.ok(error != null, 'written:false は throw で終端するべきだが error が null だった');
  const message = String(error?.message ?? '');
  assert.match(message, /pr-iterate/, 'throw メッセージに workflowName(pr-iterate) が含まれるべき');
  assert.match(message, /EnterWorktree/, 'throw メッセージに回避手順（EnterWorktree）の一部が含まれるべき');
  assert.match(
    message,
    /Workflow\(\{ name: "pr-iterate", args: "5" \}\)/,
    'throw メッセージの再実行手順は workflow 名 pr-iterate・PR 番号 args を指すべき（issue #455: dev-flow 誤 workflow 名の再発防止）',
  );
  assert.doesNotMatch(message, /name: "dev-flow"/, 'throw メッセージが誤って dev-flow を再起動先として指示してはいけない');
  assert.equal(getReviewerCallCount(), 0, 'written:false 検知後は pr-reviewer に到達しないべき');
  assert.equal(getFixCallCount(), 0, 'written:false 検知後は fix stage に到達しないべき');
  assert.equal(result, null, 'throw で終端した場合 result は解決されない');
});

test('[isolation-wiring] written:false の throw メッセージは PR head 起点（origin/feature/x）を提示し base_ref 起点（origin/main）を提示しない', async () => {
  const { ctx } = makeSandbox({
    isolationProbeResult: { written: false, error: 'Write denied by bg-isolation guard' },
  });

  const { error } = await runPrIterateCapture(src, ctx);
  assert.ok(error != null, 'written:false は throw で終端するべきだが error が null だった');
  const message = String(error?.message ?? '');
  assert.match(
    message,
    /origin\/feature\/x/,
    'throw メッセージは PR head（origin/feature/x）を起点として提示するべき（PR の変更を含む worktree を再現する必要がある）',
  );
  assert.doesNotMatch(
    message,
    /origin\/main/,
    'throw メッセージが base_ref 起点（origin/main）を提示してはならない（PR の変更を含まない worktree になってしまう）',
  );
});

// ---- (vii) probe が null（未 stub のデフォルト）でも throw せず fail-open で完走する ----
// probe 自体の失敗（null）は fail-open。この分岐の log 文言は assert しない（既存 §(b) 相当）。

test('[isolation-probe] probe が null（未 stub のデフォルト）でも throw せず fail-open で完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: null,
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `probe null は fail-open で続行するべきだが throw された: ${error?.message}`);
  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

// ---- (b) written:true → 既存挙動不変で lgtm 完走する（不変） ----

test('[isolation-probe] written:true → 既存挙動不変で lgtm 完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: true },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `written:true で throw されるべきではないが error=${error?.message}`);
  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});
