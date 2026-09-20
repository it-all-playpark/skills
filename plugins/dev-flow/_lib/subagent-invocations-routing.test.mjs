import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash, withImplementMode } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';
import { neutralizeRegexLiterals } from './test-helpers/source-scan.mjs';

/**
 * subagent-invocations-routing.test.mjs — 全 agent() 起動が subagent_invocations に計上される
 * ことを検証する（issue #445、issue #636 で挙動ベースへ書き換え）。
 *
 * 2 層で pin する:
 *   (0) 否定 pin — dev-flow.js / pr-iterate.js の bare `agent(` 呼び出しは trackedAgent wrapper 内の
 *       2 箇所（初回 + 契約違反リトライ、issue #527）のみ。wrapper を経由しない call site が 1 つでも
 *       増えると計上漏れになるため、call site の追加そのものを静的に拒否する（「含まれてはならない」
 *       検証。VM 実行はそれぞれの scenario で到達した call site しか観測できないため、未到達 call site
 *       の計上漏れはこの否定 pin でしか検出できない）。
 *   (a) 挙動 pin — DEV_FLOW_SCENARIOS の全 scenario（success / lite / complex-fix / green-fix /
 *       final-reconcile / cross-repo / empty-diff / abort ...）で dev-flow.js を VM 実行し、journal-save
 *       payload の `subagent_invocations.total` が payload 生成時点までの観測 calls 件数と一致する。
 *   (b)(c) nested pr-iterate 分の合算と pr-iterate.js 単体起動の一致。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FLOW_PATH = join(HERE, '..', '.claude', 'workflows', 'dev-flow.js');
const PR_ITERATE_PATH = join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js');
// IMPLEMENT_MODE を 'planner' に固定（standard shape の従来経路 dev-planner → implementer を pin する。
// 'fable' 経路は devflow-implement-fable-routing.test.mjs が検証する）
const devFlowSrc = withImplementMode(readFileSync(DEV_FLOW_PATH, 'utf8'), 'planner');
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
// (0) 否定 pin: bare agent( は trackedAgent wrapper 内の 2 箇所のみ
// ============================================================

// stripComments（tools/sync-inlines.mjs）は regex literal を regex context として解釈しない既知の制約が
// あるため、前段で test-helpers/source-scan.mjs の neutralizeRegexLiterals を通して迂回する。

for (const [name, rawSrc] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
  test(`${name}: bare agent( 呼び出しは trackedAgent wrapper 内の 2 箇所のみ（wrapper 外の call site は計上漏れになるため禁止）`, () => {
    const strippedSrc = stripComments(neutralizeRegexLiterals(rawSrc));
    const bareAgentCallRe = /(?<![A-Za-z0-9_$])agent\s*\(/g;
    const matches = [...strippedSrc.matchAll(bareAgentCallRe)];
    assert.equal(matches.length, 2, `bare agent( の総出現数が 2 件ではない（${matches.length} 件）。新規 agent() call site は trackedAgent() 経由で呼ぶこと`);

    const wrapperMarker = 'async function trackedAgent(prompt, opts) {';
    const wrapperStart = strippedSrc.indexOf(wrapperMarker);
    assert.ok(wrapperStart !== -1, 'trackedAgent wrapper 定義が見つからない');
    const nextFnIdx = strippedSrc.indexOf('async function', wrapperStart + wrapperMarker.length);
    const wrapperEnd = nextFnIdx === -1 ? strippedSrc.length : nextFnIdx;
    for (const m of matches) {
      assert.ok(m.index >= wrapperStart && m.index < wrapperEnd, `bare agent( 呼び出し（index ${m.index}）が trackedAgent wrapper 本体の外にある — call site は trackedAgent() 経由で呼ぶこと`);
    }
  });
}

// ============================================================
// (a) dev-flow.js: 全 scenario で journal-save payload の total が観測 calls 件数と一致する
//     telemetryHandoff payload は journal-save 自身の trackedAgent 呼び出しより前に組み立てられるため、
//     total は「journal-save が dispatch されるまでの calls 件数」= journal-save の index と一致する
//     （success / abort / empty-diff とも同じ）。
// ============================================================
// writeFailureTelemetry 経由の failure / partial handoff（empty-diff の fail-fast、cross-repo の graceful
// 終了）は telemetry に subagent_invocations を載せない現行仕様のため突合対象外（abort handoff は載せる）。
const FAILURE_HANDOFF_SCENARIOS = new Set(['empty-diff', 'cross-repo']);

for (const [name, sc] of Object.entries(DEV_FLOW_SCENARIOS)) {
  if (FAILURE_HANDOFF_SCENARIOS.has(name)) continue;
  test(`dev-flow.js[${name}]: journal-save payload の subagent_invocations.total が payload 生成時点の calls 件数と一致する`, async () => {
    const { ctx, calls } = makeDevFlowSandbox({ overrides: sc.overrides ?? {}, workflow: sc.workflow });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, name);
    assert.equal(error !== null, sc.expectError === true, `scenario ${name}: throw の有無が想定と異なる: ${error?.message}`);

    const journalIdx = calls.findIndex((c) => c.label === 'journal-save');
    assert.ok(journalIdx >= 0, `[${name}] label 'journal-save' の call が見つからない`);
    const telemetry = extractSubagentInvocations(calls[journalIdx].prompt);
    assert.equal(telemetry.total, journalIdx, `[${name}] telemetry.total(${telemetry.total}) が journal-save までの calls 件数(${journalIdx}) と一致しない — trackedAgent を経由しない call site がある`);

    const byTypeSum = Object.values(telemetry.by_type).reduce((a, b) => a + b, 0);
    assert.equal(byTypeSum, telemetry.total, `[${name}] by_type の合計が total と一致しない`);
    for (const key of Object.keys(telemetry.by_type)) {
      assert.ok(!key.includes(':'), `[${name}] by_type キー '${key}' に namespace プレフィックスが混入している`);
    }
  });
}

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
