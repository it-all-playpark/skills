// _lib/tracked-agent-so-retry.test.mjs
// dev-flow.js / pr-iterate.js の workflow ローカル関数 trackedAgent に対する、
// StructuredOutput 契約違反限定の同一 prompt 1 回リトライ（issue #527 B-2）を検証する。
//
// makeRecordingSandbox/runDevFlowInSandbox（_lib/test-helpers/vm-sandbox.mjs）を使い、
// dev-flow.js の Setup phase（setup-base → worktree）を VM sandbox で実行する
// （issue #550 案1: resolve-base + worktree-base-check の 2 probe は単一 label 'setup-base' の
// exec-proxy 呼び出しへ統合された。issue #550 F1: 専用 clock#start probe は廃止され、start mark は
// setup-base probe の optional epoch から給電されるようになった）。'worktree' label の応答を
// throw('TEST-STOP-SENTINEL') にして run を早期終端させ、'setup-base' 呼び出し回数で
// リトライ挙動を検証する。
//
// テストケース:
//   (a) リトライ成功 — 1 回目 StructuredOutput 契約違反 throw、2 回目正常応答 → 後続へ進む
//   (b) 契約違反以外は即 throw（リトライしない、fail-closed 維持）
//   (c) リトライ 1 回で打ち切り（2 回目も契約違反なら rethrow）
//   (d) null 応答はリトライ対象外（checkWorktreeBase の fail-closed throw が維持される）
//   (e) source pin — dev-flow.js / pr-iterate.js 双方の trackedAgent 関数本体の同型性

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const prIteratePath = join(repoRoot, '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

const CONTRACT_VIOLATION_MSG =
  "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)";

function baseFixedResponses(overrides) {
  return function ({ label }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const handler = overrides[label];
      return typeof handler === 'function' ? handler() : handler;
    }
    if (label === 'setup-base') {
      return {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      };
    }
    if (label === 'worktree') throw new Error('TEST-STOP-SENTINEL');
    return null;
  };
}

// ── (a) リトライ成功 ─────────────────────────────────────────────────────

test('[tracked-agent-so-retry] (a) setup-base が 1 回目 StructuredOutput 契約違反 → 2 回目成功で後続へ進む', async () => {
  let setupBaseCallCount = 0;
  const responder = baseFixedResponses({
    'setup-base': () => {
      setupBaseCallCount += 1;
      if (setupBaseCallCount === 1) throw new Error(CONTRACT_VIOLATION_MSG);
      return {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      };
    },
  });
  const { ctx, calls } = makeRecordingSandbox(responder);
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);

  assert.ok(err, 'run がエラーなく完走した（TEST-STOP-SENTINEL に到達していない）');
  assert.match(String(err?.message ?? err), /TEST-STOP-SENTINEL/);

  const setupBaseCalls = calls.filter((c) => c.label === 'setup-base');
  assert.equal(setupBaseCalls.length, 2, 'setup-base の呼び出し回数がちょうど 2 件ではない');
});

// ── (a2) 未 opt-in call site は StructuredOutput 契約違反でもリトライしない ──
// setup-base は opts.retryOnContractViolation:true の opt-in call site だが、
// 直後の 'worktree' label は opt-in していない。同じ契約違反メッセージでも
// opt-in していない call site は即座に throw を伝播すること（issue #533 review）を検証する —
// これが無いと journal テストの sentinel 差し替えだけで trackedAgent の opt-in gate 行
// （`if (!opts?.retryOnContractViolation) throw e;`）を削除しても全テスト green のまま通ってしまう。

test('[tracked-agent-so-retry] (a2) 未 opt-in call site（worktree label）は StructuredOutput 契約違反 throw でも呼び出し1回で即伝播する', async () => {
  let worktreeCallCount = 0;
  const responder = baseFixedResponses({
    'setup-base': () => (
      {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      }
    ),
    worktree: () => {
      worktreeCallCount += 1;
      throw new Error(CONTRACT_VIOLATION_MSG);
    },
  });
  const { ctx, calls } = makeRecordingSandbox(responder);
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);

  assert.ok(err, '未 opt-in call site の契約違反 throw で run がエラーなく完走した');
  assert.match(String(err?.message ?? err), /without calling StructuredOutput/);

  const worktreeCalls = calls.filter((c) => c.label === 'worktree');
  assert.equal(
    worktreeCalls.length,
    1,
    `worktree の呼び出し回数が 1 件ではない（未 opt-in call site なのにリトライされた: ${worktreeCallCount} 回）`,
  );
});

// ── (b) 契約違反以外はリトライしない（fail-closed 維持） ────────────────────

test('[tracked-agent-so-retry] (b) setup-base が契約違反以外の throw → リトライせず即伝播', async () => {
  const responder = baseFixedResponses({
    'setup-base': () => {
      throw new Error('guard rejected this command');
    },
  });
  const { ctx, calls } = makeRecordingSandbox(responder);
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);

  assert.ok(err, '契約違反以外の throw で run がエラーなく完走した');
  assert.match(String(err?.message ?? err), /guard rejected this command/);

  const setupBaseCalls = calls.filter((c) => c.label === 'setup-base');
  assert.equal(setupBaseCalls.length, 1, 'setup-base の呼び出し回数が 1 件ではない（リトライされてしまった）');
});

// ── (c) リトライ 1 回で打ち切り ──────────────────────────────────────────

test('[tracked-agent-so-retry] (c) setup-base が 2 回とも契約違反 → 2 回で打ち切り rethrow', async () => {
  const responder = baseFixedResponses({
    'setup-base': () => {
      throw new Error(CONTRACT_VIOLATION_MSG);
    },
  });
  const { ctx, calls } = makeRecordingSandbox(responder);
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);

  assert.ok(err, '2 回連続契約違反でも run がエラーなく完走した');
  assert.match(String(err?.message ?? err), /without calling StructuredOutput/);

  const setupBaseCalls = calls.filter((c) => c.label === 'setup-base');
  assert.equal(setupBaseCalls.length, 2, 'setup-base の呼び出し回数がちょうど 2 件ではない（無限リトライ or 打ち切り漏れ）');
});

// ── (d) null 応答はリトライしない（resolveBase の fail-closed throw 維持） ──
// issue #550 案1: 統合後は resolveBase が checkWorktreeBase より先に同一 probe を消費するため、
// probe null は resolveBase の fail-closed throw（'base 解決に失敗'）で先に検出される
// （checkWorktreeBase の '起点を確認できなかった' 側には到達しない — 同一 probe object の
// null/不正は両関数へ同時に伝播するため、消費順が先の resolveBase が代表して throw する）。

test('[tracked-agent-so-retry] (d) setup-base が null → リトライせず resolveBase の fail-closed throw が発火する', async () => {
  const responder = baseFixedResponses({
    'setup-base': () => null,
  });
  const { ctx, calls } = makeRecordingSandbox(responder);
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);

  assert.ok(err, 'setup-base null 応答で run がエラーなく完走した');
  assert.match(String(err?.message ?? err), /base 解決に失敗/);

  const setupBaseCalls = calls.filter((c) => c.label === 'setup-base');
  assert.equal(setupBaseCalls.length, 1, 'setup-base の呼び出し回数が 1 件ではない（null 応答なのにリトライされた）');
});

// ── (e) source pin: 両 workflow の trackedAgent 同型性 ──────────────────

function extractTrackedAgentBody(src) {
  const marker = 'async function trackedAgent(prompt, opts) {';
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'trackedAgent 定義（async function trackedAgent(prompt, opts) {）が見つからない');
  const searchFrom = start + marker.length;
  const nextFnIdx = src.indexOf('async function', searchFrom);
  const nextSectionIdx = src.indexOf('// ----', searchFrom);
  const candidates = [nextFnIdx, nextSectionIdx].filter((i) => i !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
}

for (const [name, path] of [
  ['dev-flow.js', devFlowPath],
  ['pr-iterate.js', prIteratePath],
]) {
  test(`[tracked-agent-so-retry] (e) ${name}: trackedAgent 本体に StructuredOutput 契約違反リトライ実装が存在する`, () => {
    const src = readFileSync(path, 'utf8');
    const body = extractTrackedAgentBody(src);

    assert.match(body, /without calling StructuredOutput/, `${name} の trackedAgent 本体に契約違反判定文字列が無い`);

    const agentCallRe = /agent\(prompt, opts\)/g;
    const matches = [...body.matchAll(agentCallRe)];
    assert.equal(
      matches.length,
      2,
      `${name} の trackedAgent 本体に agent(prompt, opts) 呼び出しが 2 箇所存在しない（${matches.length} 件）`,
    );
  });
}
