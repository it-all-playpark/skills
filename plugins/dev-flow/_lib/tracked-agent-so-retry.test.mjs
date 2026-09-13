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
//   (e) pr-iterate.js — 未 opt-in call site（pr-meta）の契約違反 / 非契約違反 throw は即伝播

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const prIteratePath = join(repoRoot, '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(prIteratePath, 'utf8');

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

// ── (e) pr-iterate.js の trackedAgent も同じ契約（未 opt-in call site は契約違反でも同一 label で再呼び出ししない）──
// pr-iterate.js には現在 retryOnContractViolation を opt-in した call site が無く、全 call site が
// 例外を catch するため伝播では観測できない。fix#1（未 opt-in）を契約違反で throw させ、trackedAgent が
// 同一 label で再呼び出しせず（fix#1 は 1 回）、契約違反リトライの log も出ないことで観測する
// （issue #636 でソース pin から置換。opt-in call site が増えたら (a) と同型のテストを足す）。

test('[tracked-agent-so-retry] (e) pr-iterate.js: 未 opt-in の fix#1 が契約違反で throw → 同一 label の再呼び出し無し・リトライ log 無し', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: {
      'review#1': { decision: 'request_changes', issues: [{ severity: 'major', topic: 't', file: 'a.js', line: 1, description: 'd', suggestion: null }], summary: 'ng' },
      'fix#1': () => { throw new Error(CONTRACT_VIOLATION_MSG); },
    },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `fix#1 の throw は callFixAgent が吸収するはずだが run が throw した: ${error?.message}`);
  assert.equal(calls.filter((c) => c.label === 'fix#1').length, 1, 'fix#1 が同一 label で再呼び出しされた（未 opt-in call site でリトライが発火している）');
  assert.equal(calls.filter((c) => c.label === 'fix#1-retry').length, 1, 'fix-null-retry（別 label）は 1 回走るはず');
  assert.ok(!logs.some((l) => l.includes('契約違反で失敗 — 同一 prompt で 1 回だけリトライ')), '未 opt-in call site なのに契約違反リトライの log が出ている');
});
