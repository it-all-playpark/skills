// implementer.md は sandbox write-deny（issue #216 リトライで実証）のため、規約は dev-flow.js が
// 全 implementer spawn prompt に注入する。本テストはその注入を source pin（否定側 1 件）+ VM 挙動
// routing の 2 層で pin する（issue #636 AC-1: 「含まれる」側の自然言語文言 pin は VM 挙動へ置換済み）。
//
// 問題: implementer が evaluator.staged.md / fm_*.txt 等の一時ファイルを worktree 直下に残すと
//       `git status --porcelain --untracked-files=all` ベースの realized-diff が膨張し、
//       micro→standard の refloor 誤発火や 30 件超の CONCERN スパムが起きる（issue #216）。
//
// このテストは:
//   (2b) STAGING_CONVENTION 定義が一時ファイルの削除を指示しない（否定側 pin。AC-3 許可）
//   (3) routing: 標準経路 implementer 呼び出し全件の prompt に規約トークンが含まれる
//   (4) routing: green-fix#1（Validate red→green-fix 経路）の prompt にも規約トークンが含まれる
//   (5) routing: fix#1（Evaluate implementation-level 差し戻し経路）の prompt にも規約トークンが含まれる
// を assert する。
// implementer.md は一切読まない（旧テストの readFileSync(implementerMdPath) は完全に廃止）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// Part 1: source pin（否定側のみ）
// ============================================================

// (2b) .devflow-tmp/ の後始末を指示しない（isEphemeralPath が realized-diff から除外するため不要）。
// 削除を指示すると implementer が一時 dir の削除コマンドを組み立て、実行制御に弾かれて turn を失う。
// 定義本体のみを検査する（コメント行は規範そのものの説明を含みうるため対象外）。
test('[staging-convention] STAGING_CONVENTION 定義が一時ファイルの削除を指示しない', () => {
  const defStart = src.indexOf('const STAGING_CONVENTION');
  assert.ok(defStart !== -1, 'STAGING_CONVENTION の定義が見つからない');
  const defEnd = src.indexOf('EPOCH_INSTRUCTION', defStart);
  assert.ok(defEnd !== -1, 'STAGING_CONVENTION 定義の終端が見つからない');
  const def = src.slice(defStart, defEnd);

  for (const forbidden of ['削除せよ', '削除する', '完了前に削除']) {
    assert.ok(
      !def.includes(forbidden),
      `STAGING_CONVENTION 定義に削除指示 "${forbidden}" が含まれている（.devflow-tmp/ は realized-diff から除外済みで後始末は不要）`,
    );
  }
});

// ============================================================
// Part 2: behavioral routing pin（VM sandbox、共有 helper 使用）
// _lib/test-helpers/vm-sandbox.mjs の makeDevFlowSandbox / runWorkflowCapture を使う。
// 規約トークン（'.devflow-tmp' / 'TMPDIR' / 'staged'）が実際に injected な prompt へ
// verbatim 到達することを、標準経路・green-fix 経路・Evaluate fix 経路の 3 通りで検証する
// （旧 (1) の「usage 3 箇所」source pin を挙動証拠で代替する）。
// ============================================================

function assertTokens(call, label) {
  assert.ok(call != null, `label === '${label}' の call が見つからない`);
  for (const token of ['.devflow-tmp', 'TMPDIR', 'staged']) {
    assert.ok(
      call.prompt.includes(token),
      `${label} prompt に '${token}' が含まれない。STAGING_CONVENTION が注入されていない`,
    );
  }
}

// (3) routing: 標準経路の implementer 呼び出し全件に規約トークンが含まれる
test('[staging-convention] routing: 標準経路の implementer prompt 全件に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'staging-convention-standard');

  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(
    implCalls.length >= 1,
    `implementer が呼ばれていない（0 件）。standard 経路で serial task が実行されるはず`,
  );
  for (const c of implCalls) assertTokens(c, c.label);
});

// (4) routing: Validate red→green-fix 経路（green-fix#1）の prompt にも規約トークンが含まれる
test('[staging-convention] routing: green-fix#1 prompt に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'staging-convention-greenfix');

  const gf1 = calls.find((c) => c.label === 'green-fix#1');
  assertTokens(gf1, 'green-fix#1');
});

// (5) routing: Evaluate implementation-level 差し戻し経路（fix#1）の prompt にも規約トークンが含まれる
// complex 経路（EVAL_PASSES=EVAL_MAX）に乗せ、eval#1 で critical 差し戻し→fix#1→eval#2 で収束させる
// （eval-convergence.test.mjs AC#3 と同型のフィクスチャ）。
test('[staging-convention] routing: fix#1（Evaluate implementation 差し戻し）prompt に規約トークンが含まれる', async () => {
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
  assertNoCrash(error, 'staging-convention-fix');

  const fix1 = calls.find((c) => c.label === 'fix#1');
  assertTokens(fix1, 'fix#1');
});
