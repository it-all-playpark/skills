// _lib/quality-model-fallback.test.mjs
// dev-flow.js / pr-iterate.js の workflow ローカル関数 trackedAgent の quality model fallback を
// VM 挙動で pin する。`opts.model`（QUALITY_MODEL）付き call が null を返したら model 指定を外して
// 同一 prompt・同一 label で 1 回だけ再試行し、以後 run 単位で sticky に既定 model へ切り替わる。
//
// テストケース:
//   dev-flow.js
//     (a)  plan#standard が model 付きで null → model 無しで再試行して完走。以後の品質ゲート call は全て
//          model 無し（sticky）。journal-save payload に quality_model_fallback_label:"plan#standard" が載り、
//          nested pr-iterate へ nested.quality_fallback:true が渡る
//     (a0) fallback 未発生の run は quality_model_fallback_label キーが無く nested.quality_fallback:false
//     (b)  plan#standard が model 無しでも null → need() の throw で abort（再試行は 1 回で打ち切り）。
//          abort handoff の payload にも quality_model_fallback_label が載る
//     (c)  model 無し call（danger-grep）の null は再試行しない・fallback log も出ない
//   pr-iterate.js
//     (a)  review#1 が model 付きで null → 同一 label・model 無しで再試行して lgtm。schema-retry は走らない。
//          journal-save payload に quality_model_fallback_label:"review#1" が載る
//     (b)  review#1 が model 無しでも null → schema-retry（別 label・model 無し）→ review_contract_error
//     (c)  model 無し call（fix#1）の null は fallback 対象外（fix-null-retry の別 label 経路のみ）
//     (d)  nested.quality_fallback:true を初期 sticky として読み、初回から model 無しで呼ぶ
//     (e)  nested.quality_fallback が boolean 以外なら起動時に throw

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, withImplementMode } from './test-helpers/vm-sandbox.mjs';
import { QUALITY_MODEL } from './quality-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
// IMPLEMENT_MODE を 'planner' に固定（standard shape の従来経路 dev-planner → implementer を pin する。
// 'fable' 経路は devflow-implement-fable-routing.test.mjs が検証する）
const devFlowSrc = withImplementMode(readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8'), 'planner');
const prIterateSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'pr-iterate.js'), 'utf8');

const FALLBACK_LOG = 'model 指定を外し frontmatter 既定で再試行';
const PLAN_OK = {
  summary: 'p',
  serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp', depends_on: [] }],
  parallel: [],
};
const APPROVE = { decision: 'approve', issues: [], summary: 'ok' };

function journalSavePrompts(calls) {
  return calls.filter((c) => c.label?.startsWith('journal-save')).map((c) => c.prompt);
}

function assertFallbackLabel(calls, label, contextLabel) {
  const prompts = journalSavePrompts(calls);
  assert.ok(prompts.length > 0, `${contextLabel}: journal-save の call が見つからない`);
  const needle = `"quality_model_fallback_label":"${label}"`;
  assert.ok(prompts.some((p) => p.includes(needle)), `${contextLabel}: journal-save prompt に ${needle} が無い`);
}

function assertNoFallbackLabel(calls, contextLabel) {
  const prompts = journalSavePrompts(calls);
  assert.ok(prompts.length > 0, `${contextLabel}: journal-save の call が見つからない`);
  assert.ok(
    prompts.every((p) => !p.includes('"quality_model_fallback_label"')),
    `${contextLabel}: fallback 未発生なのに journal-save prompt に quality_model_fallback_label キーがある（null 値は passthrough で落ちるためキー自体を省く契約）`,
  );
}

// ── dev-flow.js (a): primary null → model 省略で完走・sticky・telemetry・nested 引き渡し ──

test('[quality-model-fallback] dev-flow (a) plan#standard が model 付きで null → model 無しで再試行して完走し、以後 sticky・label が telemetry と nested args に載る', async () => {
  const nestedArgsSeen = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'plan#standard': ({ opts }) => (opts.model ? null : PLAN_OK),
    },
    workflow: async (_name, args) => {
      nestedArgsSeen.push(args);
      return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);

  const planCalls = calls.filter((c) => c.label === 'plan#standard');
  assert.deepEqual(
    planCalls.map((c) => c.model),
    [QUALITY_MODEL, null],
    'plan#standard は model 付き 1 回 + model 無し 1 回の順で呼ばれるはず',
  );
  assert.ok(logs.some((l) => l.includes('plan#standard') && l.includes(FALLBACK_LOG)), 'fallback log が出ていない');

  // sticky: fallback 以後の品質ゲート call（agentType が品質ゲート 4 種）は全て model 無し
  const qualityTypes = new Set(['dev-flow:dev-planner', 'dev-flow:plan-reviewer', 'dev-flow:evaluator', 'dev-flow:pr-reviewer']);
  const afterIdx = calls.findIndex((c) => c.label === 'plan#standard' && c.model === null);
  const laterQuality = calls.slice(afterIdx + 1).filter((c) => qualityTypes.has(c.agentType));
  assert.ok(laterQuality.length > 0, 'fallback 後に品質ゲート call が 1 件も無い（テスト前提が崩れている）');
  assert.ok(laterQuality.every((c) => c.model === null), `fallback 後の品質ゲート call に model 付きが残っている: ${JSON.stringify(laterQuality.filter((c) => c.model !== null).map((c) => c.label))}`);
  // それ以外の call site（exec-proxy / implementer）は元々 model を渡さない
  assert.ok(calls.every((c) => c.model === null || qualityTypes.has(c.agentType)), '品質ゲート以外の call site に model が付いている');

  assertFallbackLabel(calls, 'plan#standard', 'dev-flow (a)');
  assert.equal(nestedArgsSeen.length, 1, 'nested pr-iterate はちょうど 1 回起動されるはず');
  assert.equal(nestedArgsSeen[0]?.nested?.quality_fallback, true, 'nested.quality_fallback が true で渡っていない');
});

// ── dev-flow.js (a0): fallback 未発生 → キー省略・nested false ──

test('[quality-model-fallback] dev-flow (a0) fallback 未発生の run は quality_model_fallback_label キーが無く nested.quality_fallback:false', async () => {
  const nestedArgsSeen = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    workflow: async (_name, args) => {
      nestedArgsSeen.push(args);
      return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), 'fallback 未発生なのに fallback log が出ている');
  const planCalls = calls.filter((c) => c.label === 'plan#standard');
  assert.deepEqual(planCalls.map((c) => c.model), [QUALITY_MODEL], 'plan#standard は model 付き 1 回だけのはず');
  assertNoFallbackLabel(calls, 'dev-flow (a0)');
  assert.equal(nestedArgsSeen[0]?.nested?.quality_fallback, false, 'nested.quality_fallback が false で渡っていない');
});

// ── dev-flow.js (b): model 省略も null → need() throw（既存 null 経路）・abort handoff に label ──

test('[quality-model-fallback] dev-flow (b) plan#standard が model 無しでも null → 再試行 1 回で打ち切り need() throw、abort handoff に label が載る', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'plan#standard': null } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.ok(error, 'plan#standard が null のままなら need() で throw するはず');
  assert.match(String(error?.message ?? error), /Plan\(planner#standard\) が結果を返しませんでした/);
  const planCalls = calls.filter((c) => c.label === 'plan#standard');
  assert.deepEqual(planCalls.map((c) => c.model), [QUALITY_MODEL, null], 'plan#standard は model 付き + model 無しの 2 回で打ち切られるはず（無限再試行しない）');
  assertFallbackLabel(calls, 'plan#standard', 'dev-flow (b) abort');
});

// ── dev-flow.js (c): model 無し call の null は再試行しない ──

test('[quality-model-fallback] dev-flow (c) model 無し call（danger-grep）の null は再試行せず fallback log も出ない', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { 'danger-grep': null } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `danger-grep null は fail-closed 継続のはずだが throw した: ${error?.message}`);
  const dangerCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dangerCalls.length, 1, 'danger-grep が再試行された（model 無し call は fallback 対象外）');
  assert.equal(dangerCalls[0].model, null, 'danger-grep に model が付いている');
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), 'model 無し call で fallback log が出ている');
  assertNoFallbackLabel(calls, 'dev-flow (c)');
});

// ── pr-iterate.js (a): review#1 が model 付きで null → 同一 label・model 無しで lgtm ──

test('[quality-model-fallback] pr-iterate (a) review#1 が model 付きで null → model 無しで再試行して lgtm、schema-retry 無し、label が telemetry に載る', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: { 'review#1': ({ opts }) => (opts.model ? null : APPROVE) },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `status は lgtm のはずだが ${result?.status}`);
  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(
    reviewerCalls.map((c) => [c.label, c.model]),
    [['review#1', QUALITY_MODEL], ['review#1', null]],
    'pr-reviewer は review#1（model 付き）→ review#1（model 無し）の 2 回のみで、schema-retry は走らないはず',
  );
  assert.equal(result?.review_null_retries, 0, 'fallback は callReviewAgent の schema-retry ではないので review_null_retries は増えない');
  assert.ok(logs.some((l) => l.includes('review#1') && l.includes(FALLBACK_LOG)), 'fallback log が出ていない');
  assertFallbackLabel(calls, 'review#1', 'pr-iterate (a)');
});

// ── pr-iterate.js (b): model 無しでも null → schema-retry → review_contract_error ──

test('[quality-model-fallback] pr-iterate (b) review#1 が model 無しでも null → schema-retry（model 無し）→ review_contract_error', async () => {
  const { ctx, calls } = makePrIterateSandbox({ overrides: { 'review#1': null, 'review#1-schema-retry': null } });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `graceful 終了のはずだが throw した: ${error?.message}`);
  assert.equal(result?.status, 'review_contract_error', `status は review_contract_error のはずだが ${result?.status}`);
  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(
    reviewerCalls.map((c) => [c.label, c.model]),
    [['review#1', QUALITY_MODEL], ['review#1', null], ['review#1-schema-retry', null]],
    'fallback 1 回 → sticky のまま schema-retry 1 回の順で打ち切られるはず',
  );
  assert.equal(result?.review_null_retries, 1, 'schema-retry の計上（review_null_retries）は既存契約のまま 1');
  assertFallbackLabel(calls, 'review#1', 'pr-iterate (b)');
});

// ── pr-iterate.js (c): model 無し call（fix#1）の null は fallback 対象外 ──

test('[quality-model-fallback] pr-iterate (c) model 無し call（fix#1）の null は同一 label で再試行されず fallback log も出ない', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: {
      'review#1': { decision: 'request_changes', issues: [{ severity: 'major', topic: 't', file: 'a.js', line: 1, description: 'd', suggestion: null }], summary: 'ng' },
      'fix#1': null,
    },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  assert.equal(calls.filter((c) => c.label === 'fix#1').length, 1, 'fix#1 が同一 label で再試行された（model 無し call は fallback 対象外）');
  assert.equal(calls.filter((c) => c.label === 'fix#1-retry').length, 1, 'fix-null-retry（別 label）の既存経路は 1 回走るはず');
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), 'model 無し call で fallback log が出ている');
  assertNoFallbackLabel(calls, 'pr-iterate (c)');
});

// ── pr-iterate.js (d): nested.quality_fallback:true を初期 sticky として継承 ──

test('[quality-model-fallback] pr-iterate (d) nested.quality_fallback:true なら初回から model 無しで呼び、自 run では fallback を記録しない', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: { cwd: '/wt', head_ref: 'feature/issue-1', quality_fallback: true } },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm');
  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(reviewerCalls.map((c) => [c.label, c.model]), [['review#1', null]], '継承 sticky なら review#1 は最初から model 無し 1 回のはず');
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), '継承時は自 run で fallback が発火していないので log は出ない');
  // 発火したのは親 run なので label は親（dev-flow entry）が持つ。pr-iterate entry ではキー省略
  assertNoFallbackLabel(calls, 'pr-iterate (d)');
});

test('[quality-model-fallback] pr-iterate (d0) nested.quality_fallback 未指定 / false は単体起動と同じく model 付きで呼ぶ', async () => {
  for (const nested of [{ cwd: '/wt', head_ref: 'feature/issue-1' }, { cwd: '/wt', head_ref: 'feature/issue-1', quality_fallback: false }]) {
    const { ctx, calls } = makePrIterateSandbox({ args: { pr: '7', post_terminal_summary: false, nested } });
    const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
    assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
    const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
    assert.deepEqual(reviewerCalls.map((c) => c.model), [QUALITY_MODEL], `nested=${JSON.stringify(nested)} で review#1 が model 付きで呼ばれていない`);
  }
});

// ── pr-iterate.js (e): nested.quality_fallback の型違反は明示 throw ──

test('[quality-model-fallback] pr-iterate (e) nested.quality_fallback が boolean 以外なら起動時に throw', async () => {
  const { ctx, calls } = makePrIterateSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: { cwd: '/wt', head_ref: 'feature/issue-1', quality_fallback: 'yes' } },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.ok(error, 'boolean 以外の quality_fallback は throw するはず');
  assert.match(String(error?.message ?? error), /nested\.quality_fallback は boolean/);
  assert.equal(calls.length, 0, 'args 検証は agent 起動前に行われるはず');
});
