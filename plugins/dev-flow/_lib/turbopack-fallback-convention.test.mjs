// implementer.md / evaluator.md / dev-runner*.md は sandbox write-deny のため、Turbopack fallback
// 規約は dev-flow.js が全 implementer/evaluator/dev-runner spawn prompt に注入する（issue #292）。
//
// 背景: sandbox 内で Next.js の `next build`（Turbopack）が process 生成・ポートバインド制限により
//       TurbopackInternalError (os error 1) で決定的に失敗する既知事象がある。implementer が
//       git stash 等の対照実験を毎回再発明するのを防ぐため、`next build --webpack` 等の非 Turbopack
//       fallback で build 検証してよい旨を規約化する（Next.js 以外のプロジェクトには適用しない）。
//
// このテストは dev-flow.js を VM で実行し、注入先 5 経路の prompt（implPrompt / test prompt /
// green-fix / evaluator / fix#i）に規約の識別トークン（error 名 `TurbopackInternalError` と
// fallback コマンド `next build --webpack`）が verbatim 到達することで注入を観測する
// （issue #636: 識別子出現回数・区間切り出し・定義文字列のキーワード pin を VM 挙動へ置換）。
//   (1) 標準経路: impl:serial:t1 / test#1 / eval#1 の prompt にトークンが含まれる
//   (2) Validate red→green-fix 経路: green-fix#1 の prompt にトークンが含まれる
//   (3) Evaluate implementation 差し戻し経路: fix#1 の prompt にトークンが含まれる
//   (4) 定義が inline 生成区間外（最後の END inline マーカーより後）にあること（inline 区間整合）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const TOKENS = ['TurbopackInternalError', 'next build --webpack'];

function assertTokens(call, label) {
  assert.ok(call != null, `label === '${label}' の call が見つからない`);
  for (const t of TOKENS) {
    assert.ok(call.prompt.includes(t), `${label} の prompt に Turbopack fallback 規約のトークン '${t}' が含まれない（issue #292）`);
  }
}

// (1) 標準経路: implementer / test prompt / evaluator
test('[turbopack-fallback] 標準経路: implementer / test#1 / eval#1 の prompt に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'turbopack-standard');
  for (const label of ['impl:serial:t1', 'test#1', 'eval#1']) {
    assertTokens(calls.find((c) => c.label === label), label);
  }
});

// (2) Validate red→green-fix 経路
test('[turbopack-fallback] green-fix#1 prompt に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'turbopack-greenfix');
  assertTokens(calls.find((c) => c.label === 'green-fix#1'), 'green-fix#1');
});

// (3) Evaluate implementation 差し戻し経路（complex 経路で eval#1 critical → fix#1 → eval#2 収束）
test('[turbopack-fallback] fix#1（Evaluate implementation 差し戻し）prompt に規約トークンが含まれる', async () => {
  const ac = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'analyze#1': {
        summary: 's', acceptance_criteria: ['a', 'b'], issue_type: 'feat', scope: 'src',
        estimated_change_file_count: 7, shape: 'complex', issue_number: 1, issue_title: 'stub-issue-title',
      },
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: ac, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
        ac_results: ac, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
      },
    },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'turbopack-fix');
  assertTokens(calls.find((c) => c.label === 'fix#1'), 'fix#1');
});

// (4) 定義が inline 生成区間外にあること（inline 生成区間の整合 — sync-inlines が上書きする区間に
//     手書き定数を置くと次回 --write で消える）
test('[turbopack-fallback] 定数定義が inline 生成区間外（最後の END inline マーカーより後）にある', () => {
  const defIndex = src.indexOf('const TURBOPACK_FALLBACK_CONVENTION');
  assert.ok(defIndex !== -1, 'TURBOPACK_FALLBACK_CONVENTION の定義が見つからない');
  const lastEndIdx = src.lastIndexOf('// ==== END inline:');
  assert.ok(lastEndIdx !== -1, 'dev-flow.js に END inline マーカーが見つからない');
  assert.ok(defIndex > lastEndIdx, `TURBOPACK_FALLBACK_CONVENTION の定義（index ${defIndex}）が最後の END inline マーカー（index ${lastEndIdx}）より前にある — inline 生成区間内への誤配置の疑い`);
});
