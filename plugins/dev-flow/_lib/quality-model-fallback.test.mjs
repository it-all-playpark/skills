// _lib/quality-model-fallback.test.mjs
// dev-flow.js / pr-iterate.js の workflow ローカル関数 trackedAgent の quality model fallback を
// VM 挙動で pin する。`opts.model`（QUALITY_MODEL）付き call が null を返したら model 指定を外して
// 同一 prompt・同一 label で 1 回だけ再試行し、以後 run 単位で sticky に既定 model へ切り替わる。
//
// テストケース:
//   dev-flow.js
//     (a)  eval#1 が model 付きで null → model 無しで再試行して完走。以後の品質ゲート call は全て
//          model 無し（sticky）。journal-save payload に quality_model_fallback_label:"eval#1" が載り、
//          nested pr-iterate へ nested.quality_fallback:true が渡る
//     (a0) fallback 未発生の run は quality_model_fallback_label キーが無く nested.quality_fallback:false
//     (b)  eval#1 が model 無しでも null → need() の throw で abort（再試行は 1 回で打ち切り）。
//          abort handoff の payload にも quality_model_fallback_label が載る
//     (c)  model 無し call（danger-grep）の null は再試行しない・fallback log も出ない
//   pr-iterate.js（pr-reviewer は model override を渡さず frontmatter 既定で spawn するため、
//   pr-iterate 内に fallback が発火する call site は無い）
//     (a)  review#1（model 無し）が null → schema-retry（別 label・model 無し）で lgtm。fallback は発火せず
//          journal-save payload に quality_model_fallback_label が無く review_model_config:"opus" が載る
//     (b)  review#1 も schema-retry も null → review_contract_error（pr-reviewer 呼び出しは 2 回で打ち切り）
//     (c)  model 無し call（fix#1）の null は fallback 対象外（fix-null-retry の別 label 経路のみ）
//     (d)  nested.quality_fallback:true（evaluator 由来の sticky）は受理されるが pr-reviewer の挙動には影響しない
//     (d0) nested.quality_fallback 未指定 / false でも pr-reviewer は model 無し
//     (e)  nested.quality_fallback が boolean 以外なら起動時に throw

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';
import { QUALITY_MODEL } from './quality-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'pr-iterate.js'), 'utf8');

const FALLBACK_LOG = 'model 指定を外し frontmatter 既定で再試行';
// dev-flow.js で QUALITY_MODEL 付きの call site は evaluator（eval#i）のみ（issue #673 で planner 系を撤去）。
// (a) は complex 経路で eval#1 fail → reimpl#1 → eval#2 pass と回し、fallback 後の品質ゲート call（eval#2）を観測する。
const COMPLEX_REQ = {
  summary: 's', acceptance_criteria: ['a', 'b'], issue_type: 'feat', scope: 'src',
  estimated_change_file_count: 7, shape: 'complex', issue_number: 1, issue_title: 'stub-issue-title',
};
const AC2 = [
  { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
];
const EVAL_FAIL = {
  verdict: 'fail', total: 5, threshold: 7,
  feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
  feedback_level: 'implementation', ac_results: AC2, security_clearance: [],
};
const EVAL_PASS = {
  verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
  ac_results: AC2, security_clearance: [],
  critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
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

test('[quality-model-fallback] dev-flow (a) eval#1 が model 付きで null → model 無しで再試行して完走し、以後 sticky・label が telemetry と nested args に載る', async () => {
  const nestedArgsSeen = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'analyze#1': COMPLEX_REQ,
      'eval#1': ({ opts }) => (opts.model ? null : EVAL_FAIL),
      'eval#2': EVAL_PASS,
    },
    workflow: async (_name, args) => {
      nestedArgsSeen.push(args);
      return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);

  const eval1Calls = calls.filter((c) => c.label === 'eval#1');
  assert.deepEqual(
    eval1Calls.map((c) => c.model),
    [QUALITY_MODEL, null],
    'eval#1 は model 付き 1 回 + model 無し 1 回の順で呼ばれるはず',
  );
  assert.ok(logs.some((l) => l.includes('eval#1') && l.includes(FALLBACK_LOG)), 'fallback log が出ていない');

  // sticky: fallback 以後の evaluator call は全て model 無し
  const afterIdx = calls.findIndex((c) => c.label === 'eval#1' && c.model === null);
  const laterEval = calls.slice(afterIdx + 1).filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(laterEval.length > 0, 'fallback 後に evaluator call が 1 件も無い（テスト前提が崩れている）');
  assert.ok(laterEval.every((c) => c.model === null), `fallback 後の evaluator call に model 付きが残っている: ${JSON.stringify(laterEval.filter((c) => c.model !== null).map((c) => c.label))}`);
  // model を渡す call site は evaluator 系のみ。pr-reviewer（pr-review-lite）を含む他の call site は元々 model を渡さない
  assert.ok(calls.every((c) => c.model === null || c.agentType === 'dev-flow:evaluator'), `evaluator 以外の call site に model が付いている: ${JSON.stringify(calls.filter((c) => c.model !== null && c.agentType !== 'dev-flow:evaluator').map((c) => c.label))}`);

  assertFallbackLabel(calls, 'eval#1', 'dev-flow (a)');
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
  const eval1Calls = calls.filter((c) => c.label === 'eval#1');
  assert.deepEqual(eval1Calls.map((c) => c.model), [QUALITY_MODEL], 'eval#1 は model 付き 1 回だけのはず');
  assertNoFallbackLabel(calls, 'dev-flow (a0)');
  assert.equal(nestedArgsSeen[0]?.nested?.quality_fallback, false, 'nested.quality_fallback が false で渡っていない');
});

// ── dev-flow.js (b): model 省略も null → need() throw（既存 null 経路）・abort handoff に label ──

test('[quality-model-fallback] dev-flow (b) eval#1 が model 無しでも null → 再試行 1 回で打ち切り need() throw、abort handoff に label が載る', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'eval#1': null } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.ok(error, 'eval#1 が null のままなら need() で throw するはず');
  assert.match(String(error?.message ?? error), /Evaluate\(eval#1\) が結果を返しませんでした/);
  const eval1Calls = calls.filter((c) => c.label === 'eval#1');
  assert.deepEqual(eval1Calls.map((c) => c.model), [QUALITY_MODEL, null], 'eval#1 は model 付き + model 無しの 2 回で打ち切られるはず（無限再試行しない）');
  assertFallbackLabel(calls, 'eval#1', 'dev-flow (b) abort');
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

// ── pr-iterate.js (a): review#1（model 無し）が null → schema-retry（別 label）で lgtm。fallback は発火しない ──

test('[quality-model-fallback] pr-iterate (a) review#1 が null → schema-retry（別 label・model 無し）で lgtm。fallback は発火せず review_model_config:"opus" が telemetry に載る', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: { 'review#1': null, 'review#1-schema-retry': APPROVE },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `status は lgtm のはずだが ${result?.status}`);
  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(
    reviewerCalls.map((c) => [c.label, c.model]),
    [['review#1', null], ['review#1-schema-retry', null]],
    'pr-reviewer は model 無しの review#1 → schema-retry の 2 回のみで、同一 label の fallback 再試行は走らないはず',
  );
  assert.ok(reviewerCalls.every((c) => !('model' in (c.opts ?? {}))), 'pr-reviewer の opts に model キー自体が無いはず（override 撤廃）');
  assert.equal(result?.review_null_retries, 1, 'null に対する唯一の再試行は callReviewAgent の schema-retry（review_null_retries 1）');
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), 'pr-reviewer は model 無しなので fallback log は出ない');
  assertNoFallbackLabel(calls, 'pr-iterate (a)');
  const prompts = journalSavePrompts(calls);
  assert.ok(prompts.some((p) => p.includes('"review_model_config":"opus"')), 'journal-save prompt に review_model_config:"opus" が無い');
  assert.ok(prompts.some((p) => p.includes(`"quality_model_config":"${QUALITY_MODEL}"`)), 'quality_model_config は evaluator 設定値（QUALITY_MODEL）のまま載るはず');
});

// ── pr-iterate.js (b): review#1 も schema-retry も null → review_contract_error ──

test('[quality-model-fallback] pr-iterate (b) review#1 も schema-retry も null → review_contract_error（pr-reviewer 呼び出しは 2 回で打ち切り）', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({ overrides: { 'review#1': null, 'review#1-schema-retry': null } });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `graceful 終了のはずだが throw した: ${error?.message}`);
  assert.equal(result?.status, 'review_contract_error', `status は review_contract_error のはずだが ${result?.status}`);
  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(
    reviewerCalls.map((c) => [c.label, c.model]),
    [['review#1', null], ['review#1-schema-retry', null]],
    'review#1 → schema-retry の 2 回で打ち切られるはず（fallback の同一 label 再試行は無い）',
  );
  assert.equal(result?.review_null_retries, 1, 'schema-retry の計上（review_null_retries）は既存契約のまま 1');
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), 'pr-reviewer は model 無しなので fallback log は出ない');
  assertNoFallbackLabel(calls, 'pr-iterate (b)');
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

// ── pr-iterate.js (d): nested.quality_fallback:true（evaluator 由来の sticky）は受理され、pr-reviewer の挙動には影響しない ──

test('[quality-model-fallback] pr-iterate (d) nested.quality_fallback:true は受理されるが pr-reviewer は元々 model 無しなので挙動は変わらず、自 run では fallback を記録しない', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    args: { pr: '7', post_terminal_summary: false, nested: { cwd: '/wt', head_ref: 'feature/issue-1', quality_fallback: true } },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm');
  const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(reviewerCalls.map((c) => [c.label, c.model]), [['review#1', null]], 'review#1 は model 無し 1 回のはず');
  assert.ok(!logs.some((l) => l.includes(FALLBACK_LOG)), '自 run で fallback は発火しないので log は出ない');
  // sticky を発火したのは親 run（evaluator）なので label は親（dev-flow entry）が持つ。pr-iterate entry ではキー省略
  assertNoFallbackLabel(calls, 'pr-iterate (d)');
});

test('[quality-model-fallback] pr-iterate (d0) nested.quality_fallback 未指定 / false でも pr-reviewer は model 無しで呼ぶ（(d) と同一挙動）', async () => {
  for (const nested of [{ cwd: '/wt', head_ref: 'feature/issue-1' }, { cwd: '/wt', head_ref: 'feature/issue-1', quality_fallback: false }]) {
    const { ctx, calls } = makePrIterateSandbox({ args: { pr: '7', post_terminal_summary: false, nested } });
    const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
    assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
    const reviewerCalls = calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
    assert.deepEqual(reviewerCalls.map((c) => c.model), [null], `nested=${JSON.stringify(nested)} で review#1 に model が付いている`);
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
