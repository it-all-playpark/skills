// dev-implement-fable.md は sandbox write-deny（issue #216 リトライで実証）のため、配置規約は dev-flow.js が
// 全実装 spawn prompt（Implement / green-fix / Evaluate 差し戻し）に注入する。本テストはその注入を VM 挙動で
// pin する（issue #636 で自然言語文言 pin を VM 挙動へ置換、issue #673 で dev-implement-fable 一本に追随）。
//
// 問題: 実装 agent が evaluator.staged.md / fm_*.txt 等の一時ファイルを worktree 直下に残すと
//       `git status --porcelain --untracked-files=all` ベースの realized-diff が膨張し、
//       micro→standard の refloor 誤発火や 30 件超の CONCERN スパムが起きる（issue #216）。
//
// このテストは:
//   (2b) 実装 prompt が一時ファイルの削除を指示しない（否定側 pin。AC-3 許可）
//   (3) routing: 標準経路の dev-implement-fable 呼び出し全件の prompt に規約トークンが含まれる
//   (4) routing: green-fix#1（Validate red→green-fix 経路）の prompt にも規約トークンが含まれる
//   (5) routing: reimpl#1（Evaluate 差し戻し経路）の prompt にも規約トークンが含まれる
// を assert する。agent 定義ファイルは一切読まない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const FABLE = 'dev-flow:dev-implement-fable';

// ============================================================
// Part 1: 否定側 pin（VM 挙動）
// ============================================================

// (2b) .devflow-tmp/ の後始末を指示しない（isEphemeralPath が realized-diff から除外するため不要）。
// 削除を指示すると agent が一時 dir の削除コマンドを組み立て、実行制御に弾かれて turn を失う。
test('[staging-convention] 実装 prompt が一時ファイルの削除を指示しない', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, '2b');
  const implCalls = calls.filter((c) => c.agentType === FABLE);
  assert.ok(implCalls.length >= 1, 'dev-implement-fable が呼ばれていない');
  for (const c of implCalls) {
    for (const forbidden of ['削除せよ', '削除する', '完了前に削除']) {
      assert.ok(!c.prompt.includes(forbidden), `prompt (label=${c.label}) に削除指示 "${forbidden}" が含まれている（.devflow-tmp/ は realized-diff から除外済みで後始末は不要）`);
    }
  }
});

// ============================================================
// Part 2: behavioral routing pin（VM sandbox、共有 helper 使用）
// 規約トークン（'.devflow-tmp' / 'TMPDIR' / 'staged'）が実際に injected な prompt へ
// verbatim 到達することを、標準経路・green-fix 経路・Evaluate 差し戻し経路の 3 通りで検証する。
// ============================================================

function assertTokens(call, label) {
  assert.ok(call != null, `label === '${label}' の call が見つからない`);
  assert.equal(call.agentType, FABLE, `${label} の agentType が ${call.agentType}（dev-implement-fable のはず）`);
  for (const token of ['.devflow-tmp', 'TMPDIR', 'staged']) {
    assert.ok(call.prompt.includes(token), `${label} prompt に '${token}' が含まれない。STAGING_CONVENTION が注入されていない`);
  }
}

// (3) routing: 標準経路の dev-implement-fable 呼び出し全件に規約トークンが含まれる
test('[staging-convention] routing: 標準経路の dev-implement-fable prompt 全件に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'staging-convention-standard');
  const implCalls = calls.filter((c) => c.agentType === FABLE);
  assert.ok(implCalls.length >= 1, 'dev-implement-fable が呼ばれていない（0 件）');
  for (const c of implCalls) assertTokens(c, c.label);
});

// (4) routing: Validate red→green-fix 経路（green-fix#1）の prompt にも規約トークンが含まれる
test('[staging-convention] routing: green-fix#1 prompt に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'staging-convention-greenfix');
  assertTokens(calls.find((c) => c.label === 'green-fix#1'), 'green-fix#1');
});

// (5) routing: Evaluate 差し戻し経路（reimpl#1）の prompt にも規約トークンが含まれる
// complex 経路（EVAL_PASSES=EVAL_MAX）に乗せ、eval#1 で critical 差し戻し→reimpl#1→eval#2 で収束させる
// （eval-convergence.test.mjs AC#3 と同型のフィクスチャ）。
test('[staging-convention] routing: reimpl#1（Evaluate 差し戻し）prompt に規約トークンが含まれる', async () => {
  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'analyze#1': {
        summary: 's', acceptance_criteria: ['a', 'b'], issue_type: 'feat', scope: 'src',
        estimated_change_file_count: 7, shape: 'complex', issue_number: 1,
        issue_title: 'stub-issue-title',
      },
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
        ac_results: ac4, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
      },
    },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'staging-convention-reimpl');
  assertTokens(calls.find((c) => c.label === 'reimpl#1:serial:issue-1'), 'reimpl#1:serial:issue-1');
  assert.equal(calls.filter((c) => c.label === 'fix#1').length, 0, 'implementer 向け fix#1 が起動した（reimpl#1 に統合済みのはず）');
});
