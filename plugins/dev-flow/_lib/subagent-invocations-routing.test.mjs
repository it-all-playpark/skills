import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

/**
 * subagent-invocations-routing.test.mjs — 全 agent() 起動が subagent_invocations に計上される
 * ことを VM 実行の挙動テストで検証する（issue #445 → issue #636 で静的 bare `agent(` count から
 * 挙動ベースへ全面書き換え）。
 *
 * dev-flow.js / pr-iterate.js の全 agent() 呼び出しは trackedAgent() 経由で
 * SUBAGENT_COUNTS へ計上される（bare `agent(` の残存は tracked-agent-failure-policy.test.mjs の
 * 未分類 label 検出が別途保証する）。本ファイルは「実際に起動した agent() の総数」と
 * telemetry が報告する `subagent_invocations.total` が一致することを、記録済み calls 配列との
 * 突合で検証する。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FLOW_PATH = join(HERE, '..', '.claude', 'workflows', 'dev-flow.js');
const PR_ITERATE_PATH = join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(DEV_FLOW_PATH, 'utf8');
const prIterateSrc = readFileSync(PR_ITERATE_PATH, 'utf8');

// journal-save prompt に埋め込まれる telemetry JSON 断片を抜き出す（JSON.stringify 出力は
// 空白なしなので key の直後を素直に切り出せる）。
function extractSubagentInvocations(prompt) {
  const idx = prompt.indexOf('"subagent_invocations"');
  assert.ok(idx !== -1, 'prompt に "subagent_invocations" キーが見つからない');
  // "subagent_invocations":{"total":N,"by_type":{...}} の閉じ } を brace depth で追跡して切り出す。
  const start = prompt.indexOf('{', idx);
  let depth = 0;
  let end = start;
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === '{') depth++;
    else if (prompt[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return JSON.parse(prompt.slice(start, end));
}

// ============================================================
// (a) dev-flow.js 既定 run（fixes_applied:0、nested pr-iterate stub は subagent_invocations 無し）
// ============================================================
test('dev-flow.js: journal-save prompt の subagent_invocations.total は payload 生成時点の calls 件数と一致する（journal-save/journal-log 自身は未計上）', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ issue: 1 });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `既定 run はエラーなく完走するべき: ${error?.message}`);

  const journalSaveCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalSaveCall, "label 'journal-save' の call が見つからない");
  const telemetry = extractSubagentInvocations(journalSaveCall.prompt);

  // telemetryHandoff payload は journal-save / journal-log 自身の trackedAgent 呼び出しより前に
  // 組み立てられるため、total は「その時点までの calls 件数」= calls.length - 2
  // （journal-save, journal-log の 2 件が未計上）と一致する。
  const uncountedAtPayloadTime = 2;
  assert.equal(
    telemetry.total,
    calls.length - uncountedAtPayloadTime,
    `telemetry.total(${telemetry.total}) が calls.length(${calls.length}) - ${uncountedAtPayloadTime} と一致しない`,
  );

  const byTypeSum = Object.values(telemetry.by_type).reduce((a, b) => a + b, 0);
  assert.equal(byTypeSum, telemetry.total, 'by_type の合計が total と一致しない');

  // by_type のキーは namespace 無しの bare agentType 名であること（'dev-flow:dev-runner' 等ではない）。
  for (const key of Object.keys(telemetry.by_type)) {
    assert.ok(!key.includes(':'), `by_type キー '${key}' に namespace プレフィックスが混入している`);
  }
});

// ============================================================
// (b) nested workflow('dev-flow:pr-iterate') の subagent_invocations が合算される
// ============================================================
test("dev-flow.js: nested workflow('pr-iterate') の subagent_invocations が dev-flow 側 total/by_type に合算される", async () => {
  const { ctx: ctxA, calls: callsA } = makeDevFlowSandbox({ issue: 1 });
  const { error: errA } = await runWorkflowCapture(devFlowSrc, ctxA);
  assert.equal(errA, null, `baseline run はエラーなく完走するべき: ${errA?.message}`);
  const telemetryA = extractSubagentInvocations(callsA.find((c) => c.label === 'journal-save').prompt);

  const nestedStub = async () => ({
    status: 'lgtm', iterations: 1, fixes_applied: 0,
    subagent_invocations: { total: 3, by_type: { 'pr-reviewer': 1, 'dev-runner': 2 } },
  });
  const { ctx: ctxB, calls: callsB } = makeDevFlowSandbox({ issue: 1, workflow: nestedStub });
  const { error: errB } = await runWorkflowCapture(devFlowSrc, ctxB);
  assert.equal(errB, null, `nested-stub run はエラーなく完走するべき: ${errB?.message}`);
  const telemetryB = extractSubagentInvocations(callsB.find((c) => c.label === 'journal-save').prompt);

  assert.equal(telemetryB.total, telemetryA.total + 3, 'nested pr-iterate 分（3 件）が total に合算されていない');
  assert.equal(
    (telemetryB.by_type['pr-reviewer'] ?? 0),
    (telemetryA.by_type['pr-reviewer'] ?? 0) + 1,
    "nested pr-iterate 分の by_type['pr-reviewer'] が 1 件合算されていない",
  );
});

// ============================================================
// (c) pr-iterate.js 単体起動
// ============================================================
test('pr-iterate.js: 単体起動時の result.subagent_invocations.total は calls.length と完全一致する（journal-log 完了後に再計算されるため）', async () => {
  const { ctx, calls } = makePrIterateSandbox({ args: '5' });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `既定 run はエラーなく完走するべき: ${error?.message}`);
  assert.ok(result.subagent_invocations, 'result.subagent_invocations が無い');
  assert.equal(
    result.subagent_invocations.total,
    calls.length,
    `result.subagent_invocations.total(${result.subagent_invocations.total}) が calls.length(${calls.length}) と一致しない`,
  );
  const byTypeSum = Object.values(result.subagent_invocations.by_type).reduce((a, b) => a + b, 0);
  assert.equal(byTypeSum, result.subagent_invocations.total, 'by_type の合計が total と一致しない');

  const journalSaveCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalSaveCall, "label 'journal-save' の call が見つからない");
  assert.ok(
    journalSaveCall.prompt.includes('"subagent_invocations"'),
    "pr-iterate.js の journal-save prompt に \"subagent_invocations\" キーが見つからない",
  );
});
