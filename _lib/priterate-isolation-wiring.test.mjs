// F1 (issue #449): pr-iterate.js の review loop 進入前に isolation-probe を配線する検証テスト（TDD）。
// dev-flow.js の Setup phase 配線（_lib/isolation-probe-wiring.test.mjs）と同型だが、pr-iterate では
// review loop 進入前（fix stage 不到達の保証）に probe を置く点が異なる。純関数
// （isolationProbePrompt/isolationFailureMessage）自体は _lib/isolation-probe.test.mjs でテスト済み。
// 本ファイルは (a) source-regex による配線検証、(b) VM 実行による written:false→throw / written:true→lgtm
// 完走 / null→fail-open 完走の 3 分岐を検証する。

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

// ---- (a) source-regex 検証 ----

test('isolation-probe.mjs の inline 区間が pr-iterate.js に存在する', () => {
  assert.match(
    src,
    /\/\/ ==== BEGIN inline: _lib\/isolation-probe\.mjs/,
    'isolation-probe.mjs の inline BEGIN marker が見つからない',
  );
  assert.match(
    src,
    /\/\/ ==== END inline: _lib\/isolation-probe\.mjs ====/,
    'isolation-probe.mjs の inline END marker が見つからない',
  );
});

test('ISOLATION_PROBE schema が written(boolean, required) を持つ', () => {
  const match = src.match(/const ISOLATION_PROBE = \{[\s\S]*?\n\}/);
  assert.ok(match, 'ISOLATION_PROBE schema 宣言が見つからない');
  assert.match(match[0], /required:\s*\['written'\]/);
  assert.match(match[0], /written:\s*\{\s*type:\s*'boolean'\s*\}/);
});

test('isolation probe failOpenAgent 呼び出しが agentType/schema/label/phase 込みで存在する', () => {
  // issue #499: fail-open 規定の exec-proxy は trackedAgent を throw-safe に包む failOpenAgent 経由へ移行。
  assert.match(
    src,
    /await failOpenAgent\(isolationProbePrompt\([^)]*\),\s*\{\s*agentType:\s*'dev-runner-haiku',\s*schema:\s*ISOLATION_PROBE,\s*label:\s*'isolation-probe',\s*phase:\s*'Iterate'\s*\}\)/,
    'isolation probe の failOpenAgent() 呼び出しが期待する agentType/schema/label/phase で見つからない',
  );
});

test('probe が written:false を返した場合に isolationFailureMessage で throw する分岐が存在する', () => {
  assert.match(
    src,
    /if\s*\(isoProbe\s*&&\s*isoProbe\.written\s*===\s*false\)\s*\{[\s\S]*?throw new Error\(\s*isolationFailureMessage\(/,
    'written===false → throw new Error(isolationFailureMessage(...)) の分岐が見つからない',
  );
});

test('isolationFailureMessage の呼び出しは workflowName: pr-iterate を明示する（issue #455: dev-flow 誤 workflow 名の再発防止）', () => {
  const call = src.match(/throw new Error\(\s*isolationFailureMessage\(\{[\s\S]*?\}\)\)/);
  assert.ok(call, 'isolationFailureMessage({...}) 呼び出しが見つからない');
  assert.match(call[0], /workflowName:\s*'pr-iterate'/, 'workflowName に \'pr-iterate\' が渡されていない（dev-flow 混同の再発）');
  assert.match(call[0], /workflowArgs:\s*PR\b/, 'workflowArgs に PR（PR 番号）が渡されていない');
  assert.doesNotMatch(call[0], /workflowName:\s*'dev-flow'/, 'workflowName が誤って dev-flow になっている');
});

test('isolationFailureMessage の startRef は PR head 起点（base 起点は PR の変更を含まない worktree を提示する）', () => {
  const call = src.match(/throw new Error\(\s*isolationFailureMessage\(\{[\s\S]*?\}\)\)/);
  assert.ok(call, 'isolationFailureMessage({...}) 呼び出しが見つからない');
  assert.match(
    call[0],
    /startRef:\s*`origin\/\$\{prMeta\?\.head_ref \|\| '\?'\}`/,
    'startRef に origin/${head_ref}（PR head 起点）が渡されていない',
  );
  assert.doesNotMatch(call[0], /startRef:[^,]*base_ref/, 'startRef が base_ref 起点になっている（PR の変更を含まない worktree を提示してしまう）');
});

test('isolationFailureMessage の targetPath は isolation probe 対象の cwd（isoWt）とは別の worktree 先を渡す', () => {
  const call = src.match(/throw new Error\(\s*isolationFailureMessage\(\{[\s\S]*?\}\)\)/);
  assert.ok(call, 'isolationFailureMessage({...}) 呼び出しが見つからない');
  assert.match(call[0], /targetPath:\s*isoTargetPath/, 'targetPath に isoWt（共有 checkout の cwd）そのものではない専用変数が渡されていない');
  assert.match(src, /const isoTargetPath = /, 'isoWt とは別の worktree 提示先（isoTargetPath）を計算する行が見つからない');
});

test('probe 自体が失敗（null）した場合の fail-open log 分岐が存在する', () => {
  assert.match(
    src,
    /if\s*\(!isoProbe\)\s*log\(/,
    '!isoProbe → log(...) の fail-open 分岐が見つからない',
  );
  assert.match(src, /isolation probe 自体が失敗/, 'fail-open log メッセージが見つからない');
  assert.match(src, /fail-open で続行/, 'fail-open log メッセージに fail-open の明示が見つからない');
});

test('isolation probe は review loop（for (i = 1; i <= MAX; i++)）進入より前に配置されている', () => {
  const probeIdx = src.indexOf(`await failOpenAgent(isolationProbePrompt(`);
  const loopIdx = src.indexOf('for (i = 1; i <= MAX; i++)');
  assert.notStrictEqual(probeIdx, -1, 'isolation probe 呼び出しが見つからない');
  assert.notStrictEqual(loopIdx, -1, 'review loop の for 文が見つからない');
  assert.ok(probeIdx < loopIdx, 'isolation probe は review loop（fix stage 手前）より前に配置されるべき');
});

// ── issue #493: stale 残置物の除去（cleanup）を probe の直前・Iterate 進入前に置く ────

test('isolation cleanup failOpenAgent 呼び出しが agentType/schema/label/phase 込みで存在する', () => {
  assert.match(
    src,
    /const isoClean = await failOpenAgent\(isolationCleanupPrompt\(isoWt\),\s*\{\s*agentType:\s*'dev-runner-haiku',\s*schema:\s*ISOLATION_CLEANUP,\s*label:\s*'isolation-cleanup',\s*phase:\s*'Iterate'\s*\}\)/,
    'isolation cleanup の failOpenAgent() 呼び出しが期待する agentType/schema/label/phase で見つからない',
  );
});

test('ISOLATION_CLEANUP schema が cleaned(boolean, required) を持つ', () => {
  const match = src.match(/const ISOLATION_CLEANUP = \{[\s\S]*?\n\}/);
  assert.ok(match, 'ISOLATION_CLEANUP schema 宣言が見つからない');
  assert.match(match[0], /required:\s*\['cleaned'\]/);
  assert.match(match[0], /cleaned:\s*\{\s*type:\s*'boolean'\s*\}/);
});

test('isolation cleanup は probe より前・review loop 進入より前に配置されている', () => {
  const cleanIdx = src.indexOf('const isoClean = await failOpenAgent(isolationCleanupPrompt(isoWt)');
  const probeIdx = src.indexOf('await failOpenAgent(isolationProbePrompt(');
  const loopIdx = src.indexOf('for (i = 1; i <= MAX; i++)');
  assert.notStrictEqual(cleanIdx, -1, 'isolation cleanup 呼び出しが見つからない');
  assert.ok(cleanIdx < probeIdx, 'cleanup は probe より前に配置されるべき（stale 残置物を probe 前に除去する）');
  assert.ok(probeIdx < loopIdx, 'cleanup/probe はいずれも review loop より前に配置されるべき');
});

test('isolation cleanup の失敗は fail-open（log のみ・throw しない）', () => {
  assert.match(
    src,
    /if\s*\(!isoClean\s*\|\|\s*isoClean\.cleaned\s*!==\s*true\)\s*log\(/,
    'cleanup 失敗時の fail-open log 分岐が見つからない',
  );
  // 窓は cleanup 呼び出し 〜 probe 呼び出しの直前まで（probe 側の fail-closed throw を巻き込まない）
  const idx = src.indexOf('const isoClean = await failOpenAgent(isolationCleanupPrompt(isoWt)');
  const probeIdx = src.indexOf('const isoProbe = await failOpenAgent(isolationProbePrompt(');
  const nearby = src.slice(idx, probeIdx);
  assert.doesNotMatch(nearby, /throw new Error/, 'cleanup 失敗で throw してはならない（fail-open）');
});

// ---- (b) VM 実行検証 ----
// priterate-journal-log.test.mjs の makeSandbox/runPrIterateCapture パターンを流用。

function makeSandbox({ isolationProbeResult, journalResult }) {
  let reviewerCallCount = 0;
  let fixCallCount = 0;
  let isolationProbeCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'isolation-probe' && agentType === 'dev-runner-haiku') {
      isolationProbeCallCount += 1;
      return isolationProbeResult;
    }

    if (agentType === 'pr-reviewer') {
      reviewerCallCount += 1;
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    if (label.startsWith('fix#')) {
      fixCallCount += 1;
      return { applied: true, files: [], summary: 'fixed' };
    }

    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      return { status: 'passed', failed_checks: [] };
    }

    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    if (label === 'pr-meta' && agentType === 'dev-runner-haiku-ro') {
      return { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt' };
    }

    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
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

test('[isolation-probe] written:false → throw で終端し、review/fix stage に到達しない', async () => {
  const { ctx, getReviewerCallCount, getFixCallCount, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: false, error: 'Write denied by bg-isolation guard' },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.ok(error != null, 'written:false は throw で終端するべきだが error が null だった');
  assert.match(
    String(error?.message ?? ''),
    /EnterWorktree/,
    'throw メッセージに回避手順（EnterWorktree）の一部が含まれるべき',
  );
  assert.match(
    String(error?.message ?? ''),
    /Workflow\(\{ name: "pr-iterate", args: "5" \}\)/,
    'throw メッセージの再実行手順は workflow 名 pr-iterate・PR 番号 args を指すべき（issue #455: dev-flow 誤 workflow 名の再発防止）',
  );
  assert.doesNotMatch(
    String(error?.message ?? ''),
    /name: "dev-flow"/,
    'throw メッセージが誤って dev-flow を再起動先として指示してはいけない',
  );
  assert.equal(getReviewerCallCount(), 0, 'written:false 検知後は pr-reviewer に到達しないべき');
  assert.equal(getFixCallCount(), 0, 'written:false 検知後は fix stage に到達しないべき');
  assert.equal(result, null, 'throw で終端した場合 result は解決されない');
});

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
