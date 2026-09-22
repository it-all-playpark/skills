// _lib/analyze-contract-routing.test.mjs
// Guard test: Analyze phase の配線 pin（issue #690）。Analyze は prerun の script 段（analyze-issue --contract +
// Jev 有界判定）の結果 args.setup.analyze を whitelist 検証して REQ を組み、3 条件ゲートだけを判定する。
//
//   (a) 通常経路（AC 抽出成功・conflict 無し・uncertain 空）: Analyze phase の agent spawn が 0 件、
//       旧 label（contract-probe# / analyze# / issue-meta / analyze-retrunc# / analyze-retry#）が 0 件、run は完走
//   (b) ゲート（AC 空 / comment_conflicts 非空 / uncertain 非空）: needs_clarification が isolation-probe より前に
//       確定し、isolation-probe / dev-implement-fable / pr の spawn が 0 件、ゲート後の sonnet spawn
//       （analyze-clarify#1, dev-runner）はちょうど 1 回
//   (c) analyze.ok:false（gh 到達不能 / JSON 不正）: needs_clarification（source=analyze_prerun）で sonnet も
//       isolation-probe も spawn しない
//   (d) clarify agent の null / throw は fail-open（ゲート理由をそのまま missing_context にする）
//   (e) 通常経路の isolation-probe は Analyze ゲート後・Implement 前に 1 回（needs_clarification 経路では 0 回）
//   (f) args.setup.analyze が ok:true だが whitelist 不合格 → fail-closed throw（推測で REQ を組まない）
//   (g) clarify prompt はゲート理由を verbatim で含み、issue 転写（gh の直接実行 / sandbox 語）を指示しない
//   (h) REQ が prerun の analyze から組まれる: breaking_change / issue_body / AC が fable prompt と shape に届く
//
// Run: npx vitest run _lib/analyze-contract-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const src = readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const LEGACY_ANALYZE_LABELS = ['contract-probe#', 'analyze#', 'issue-meta', 'analyze-retrunc#', 'analyze-retry#'];

async function run({ overrides = {}, analyze = {}, args } = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides, extra: { args: args ?? analyzeArgs(1, analyze) } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'analyze-contract-routing');
  return { calls, logs, result, error };
}

function analyzePhaseCalls(calls) {
  return calls.filter((c) => c.opts?.phase === 'Analyze');
}
function legacyCalls(calls) {
  return calls.filter((c) => LEGACY_ANALYZE_LABELS.some((p) => c.label === p || c.label.startsWith(p)));
}
function fableCalls(calls) {
  return calls.filter((c) => c.agentType === 'dev-flow:dev-implement-fable');
}
function assertClarificationBeforeSpawn(calls, result, name) {
  assert.equal(result?.status, 'needs_clarification', `[${name}] status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 0, `[${name}] needs_clarification 経路で isolation-probe が spawn されている`);
  assert.equal(fableCalls(calls).length, 0, `[${name}] needs_clarification 経路で dev-implement-fable が spawn されている`);
  assert.equal(calls.filter((c) => c.label.startsWith('pr')).length, 0, `[${name}] needs_clarification 経路で pr 系が spawn されている`);
  assert.equal(legacyCalls(calls).length, 0, `[${name}] 旧 analyze 系 label が spawn されている: ${legacyCalls(calls).map((c) => c.label).join(', ')}`);
}

// ---- (a) 通常経路: Analyze phase の spawn 0 ----
test('[analyze-routing] (a) 通常経路: Analyze phase の agent spawn は 0 件、旧 analyze 系 label も 0 件で run が完走する', async () => {
  const { calls, result, error, logs } = await run();
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.equal(analyzePhaseCalls(calls).length, 0, `Analyze phase の spawn: ${analyzePhaseCalls(calls).map((c) => c.label).join(', ')}`);
  assert.equal(legacyCalls(calls).length, 0, `旧 analyze 系 label: ${legacyCalls(calls).map((c) => c.label).join(', ')}`);
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-runner').length, 0, '通常経路で dev-runner（sonnet）が spawn されている');
  assert.ok(result && typeof result === 'object' && result.status !== 'needs_clarification', `run は完走するはず: ${JSON.stringify(result?.status)}`);
  assert.ok(logs.some((l) => l.includes('Analyze phase の spawn 0')), 'Analyze phase の spawn 0 の log が無い');
});

test('[analyze-routing] (a2) jev 経路（comment_overrides のみ / breaking_change=true）も Analyze phase の spawn は 0 で run が進む', async () => {
  const { calls, result, error, logs } = await run({
    analyze: { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true', 'comments present (1)'], comment_count: 1, comment_overrides: ['override: comment #1 by reporter（NONE, t）: 訂正: 30 箇所'], breaking_change: true, breaking_evidence: 'Jev noul p=0.95' },
  });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.equal(analyzePhaseCalls(calls).length, 0);
  assert.ok(result?.status !== 'needs_clarification');
  assert.ok(logs.some((l) => l.includes('comment による body 訂正を採用（1 件）')), 'override 採用の log が無い');
  assert.ok(logs.some((l) => l.includes('breaking_change=true')), 'breaking_change の log が無い');
});

// ---- (b) ゲート 3 条件 → needs_clarification（probe / fable より前・sonnet 1 回）----
for (const [name, analyze] of [
  ['AC 空', { acceptance_criteria: [] }],
  ['comment_conflicts 非空', { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, t）: hmm'] }],
  ['uncertain 非空', { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'], uncertain: ['breaking_keyword_scan: Jev 応答なし'] }],
]) {
  test(`[analyze-routing] (b) ${name} → needs_clarification が isolation-probe / fable より前に確定し、sonnet（analyze-clarify#1）はちょうど 1 回`, async () => {
    const { calls, result, error } = await run({ analyze });
    assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
    assertClarificationBeforeSpawn(calls, result, name);
    assert.equal(result.source, 'analyze');
    const clarify = calls.filter((c) => c.label === 'analyze-clarify#1');
    assert.equal(clarify.length, 1, `analyze-clarify#1 は 1 回のはずだが ${clarify.length} 回`);
    assert.equal(clarify[0].agentType, 'dev-flow:dev-runner');
    assert.equal(clarify[0].opts.phase, 'Analyze');
    assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-runner').length, 1, 'sonnet の spawn は analyze-clarify#1 の 1 回のみ');
    // missing_context は sonnet の質問文 + 決定論のゲート理由
    assert.ok(Array.isArray(result.missing_context) && result.missing_context.includes('stub-clarify-question'), `missing_context に sonnet の質問文が無い: ${JSON.stringify(result.missing_context)}`);
    assert.ok(result.missing_context.length >= 2, 'missing_context に決定論のゲート理由が付いていない');
    assert.equal(result.worktree, '/tmp/wt');
    assert.equal(result.journal_log_status, 'logged');
  });
}

test('[analyze-routing] (b2) 3 条件が同時でも sonnet は 1 回', async () => {
  const { calls, result, error } = await run({ analyze: { acceptance_criteria: [], comment_conflicts: ['c'], uncertain: ['u'] } });
  assert.equal(error, null);
  assertClarificationBeforeSpawn(calls, result, 'all-3');
  assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1').length, 1);
});

// ---- (c) analyze.ok:false → needs_clarification（source=analyze_prerun）、spawn 0 ----
test('[analyze-routing] (c) analyze.ok:false → needs_clarification（source=analyze_prerun）で sonnet も isolation-probe も spawn しない', async () => {
  const { calls, result, error, logs } = await run({
    args: devFlowArgs(1, { analyze: { ok: false, reason: 'analyze-issue --contract failed: gh: HTTP 502', analyze_path: 'contract', duration_seconds: 2 } }),
  });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assertClarificationBeforeSpawn(calls, result, 'ok-false');
  assert.equal(result.source, 'analyze_prerun');
  assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1').length, 0, 'ok:false では sonnet を spawn しない');
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-runner').length, 0);
  // journal handoff（journal-save / journal-log-failure）以外の spawn が無い
  const nonJournal = calls.filter((c) => !c.label.startsWith('journal'));
  assert.deepEqual(nonJournal.map((c) => c.label), [], `ok:false 経路の spawn は journal handoff のみのはず: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(result.missing_context.some((m) => m.includes('HTTP 502')), `missing_context に prerun の reason が無い: ${JSON.stringify(result.missing_context)}`);
  assert.ok(logs.some((l) => l.includes('source=analyze_prerun')));
});

// ---- (d) clarify agent の失敗は fail-open ----
test('[analyze-routing] (d) analyze-clarify#1 が null / throw でもゲート理由をそのまま missing_context にして needs_clarification を返す', async () => {
  for (const [kind, override] of [['null', null], ['throw', () => { throw new Error('boom'); }]]) {
    const { calls, result, error } = await run({ analyze: { acceptance_criteria: [] }, overrides: { 'analyze-clarify#1': override } });
    assert.equal(error, null, `[${kind}] run が throw してはならないが: ${error?.message}`);
    assertClarificationBeforeSpawn(calls, result, `clarify-${kind}`);
    assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1').length, 1, `[${kind}] sonnet は 1 回（再試行しない）`);
    assert.ok(result.missing_context.some((m) => m.includes('acceptance_criteria が空')), `[${kind}] 決定論のゲート理由が missing_context に無い: ${JSON.stringify(result.missing_context)}`);
    assert.ok(!result.missing_context.includes('stub-clarify-question'));
  }
});

// ---- (e) isolation-probe の位置: ゲート後・Implement 前 ----
test('[analyze-routing] (e) 通常経路の isolation-probe は Analyze ゲート後・dev-implement-fable 前に 1 回', async () => {
  const { calls, error } = await run();
  assert.equal(error, null);
  const probeIdx = calls.findIndex((c) => c.label === 'isolation-probe');
  const implIdx = calls.findIndex((c) => c.agentType === 'dev-flow:dev-implement-fable');
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 1);
  assert.ok(probeIdx >= 0 && implIdx > probeIdx, `isolation-probe(${probeIdx}) は dev-implement-fable(${implIdx}) より前のはず`);
  // probe より前の spawn は 0（Setup / Analyze は decision-only）
  assert.equal(probeIdx, 0, `isolation-probe より前に spawn がある: ${calls.slice(0, probeIdx).map((c) => c.label).join(', ')}`);
  assert.equal(calls[probeIdx].agentType, 'dev-flow:dev-runner-haiku-wo');
});

// ---- (f) whitelist 不合格 → fail-closed throw ----
test('[analyze-routing] (f) args.setup.analyze が ok:true だが whitelist 不合格（acceptance_criteria に空文字）→ throw、spawn 0', async () => {
  const { calls, error } = await run({ analyze: { acceptance_criteria: ['a', ''] } });
  assert.ok(error, 'whitelist 不合格で throw するはず');
  assert.match(error.message, /args\.setup\.analyze が whitelist 検証に不合格/);
  assert.equal(calls.filter((c) => !c.label.startsWith('journal')).length, 0, `throw 前に spawn がある: ${calls.map((c) => c.label).join(', ')}`);
});

test('[analyze-routing] (f2) analyze_path=sonnet は入力として不合格（sonnet はゲート後に Workflow が付ける値）→ throw', async () => {
  const { error } = await run({ analyze: { analyze_path: 'sonnet' } });
  assert.ok(error);
  assert.match(error.message, /whitelist 検証に不合格/);
});

// ---- (g) clarify prompt の契約 ----
test('[analyze-routing] (g) analyze-clarify#1 prompt はゲート理由を verbatim で含み、要件の推測・sandbox 語・gh 直接実行を指示しない', async () => {
  const conflict = 'conflict: comment #1 by alice（OWNER, 2026-01-01T00:00:00Z）: 30 箇所ではなく 20 箇所';
  const { calls } = await run({ analyze: { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: [conflict] } });
  const call = calls.find((c) => c.label === 'analyze-clarify#1');
  assert.ok(call);
  assert.ok(call.prompt.includes(conflict), 'ゲート理由が verbatim で prompt に無い');
  assert.ok(call.prompt.includes('missing_context'), 'missing_context の返却指示が無い');
  assert.ok(call.prompt.includes('dev-issue-analyze 1 --depth comprehensive'), 'Skill 経由の issue 読み取り指示が無い');
  assert.ok(call.prompt.includes('推測して埋めるな'), '要件推測の禁止が無い');
  assert.ok(call.prompt.includes('date +%s'), 'EPOCH_INSTRUCTION が無い');
  assert.ok(!/sandbox|excludedCommands/.test(call.prompt), 'prompt に sandbox / excludedCommands が含まれてはならない');
  assert.ok(!call.prompt.includes('gh issue view'), 'prompt に gh の直接実行指示が含まれてはならない');
  // schema は VM realm の Array なので deepEqual（prototype 比較）ではなく JSON で突合する
  assert.equal(JSON.stringify(call.schema?.required), JSON.stringify(['missing_context']));
});

// ---- (h) REQ は prerun の analyze から組まれる ----
test('[analyze-routing] (h) prerun の analyze の issue_body / AC / issue_title が fable prompt に届き、breaking_change=true は shape=complex に倒す', async () => {
  const analyze = prerunAnalyze({ issue_title: 'feat: prerun analyze', issue_body: 'PRERUN-BODY-MARKER', acceptance_criteria: ['AC-ONE', 'AC-TWO'], breaking_change: true, breaking_evidence: 'title の breaking marker (!)' });
  const { calls, logs, error } = await run({ args: devFlowArgs(1, { analyze }) });
  assert.equal(error, null);
  const impl = calls.find((c) => c.agentType === 'dev-flow:dev-implement-fable');
  assert.ok(impl);
  assert.ok(impl.prompt.includes('PRERUN-BODY-MARKER'), 'issue_body が fable prompt に無い');
  assert.ok(impl.prompt.includes('AC-ONE') && impl.prompt.includes('AC-TWO'), 'AC が fable prompt に無い');
  assert.ok(impl.prompt.includes('feat: prerun analyze'), 'issue_title が fable prompt に無い');
  assert.ok(logs.some((l) => /shape=complex|floor=complex|breaking change detected/.test(l)), `breaking_change=true が shape に反映されていない: ${logs.filter((l) => l.includes('shape')).join(' | ')}`);
});
