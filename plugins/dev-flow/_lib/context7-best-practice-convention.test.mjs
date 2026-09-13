// implementer.md は sandbox write-deny かつ本 issue の AC で編集禁止のため、framework best-practice
// 参照規約（vendored SKILL.md 読み込みから条件付き context7 参照への置換。issue #497）は
// TURBOPACK_FALLBACK_CONVENTION と同型で dev-flow.js が implementer spawn prompt に注入する。
//
// このテストは dev-flow.js を VM で実行し、注入先 3 経路（implPrompt / green-fix#i / fix#i）の prompt に
// 規約の識別トークン（bare 名コマンド `detect-stack .` と tool 名 `context7`）が verbatim 到達し、
// 非注入先（test prompt / evaluator prompt）には到達しないことで注入箇所を観測する
// （issue #636: 識別子出現回数・区間切り出し・定義文字列のキーワード pin を VM 挙動へ置換）。
//   (1) 標準経路: impl:serial:t1 に含まれ、test#1 / eval#1 には含まれない
//   (2) Validate red→green-fix 経路: green-fix#1 に含まれる
//   (3) Evaluate implementation 差し戻し経路: fix#1 に含まれる（eval#1 / eval#2 には含まれない）
//   (4) 定義が inline 生成区間外（最後の END inline マーカーより後）にあること（inline 区間整合）
//
// test-prompt（dev-runner）と evaluator prompt には注入しない — implementer ではなく、evaluator が
// 判定するのは diff であって docs ではないため（TURBOPACK_FALLBACK_CONVENTION とは注入箇所数が異なる）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const TOKENS = ['detect-stack .', 'context7'];

function assertInjected(call, label) {
  assert.ok(call != null, `label === '${label}' の call が見つからない`);
  for (const t of TOKENS) {
    assert.ok(call.prompt.includes(t), `${label} の prompt に context7 規約のトークン '${t}' が含まれない（issue #497）`);
  }
}

function assertNotInjected(call, label) {
  assert.ok(call != null, `label === '${label}' の call が見つからない`);
  for (const t of TOKENS) {
    assert.ok(!call.prompt.includes(t), `${label} の prompt に context7 規約のトークン '${t}' が含まれている（implementer 以外へは注入しない）`);
  }
}

// (1) 標準経路
test('[context7-best-practice] 標準経路: implementer prompt に含まれ、test#1 / eval#1 には含まれない', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'context7-standard');
  assertInjected(calls.find((c) => c.label === 'impl:serial:t1'), 'impl:serial:t1');
  assertNotInjected(calls.find((c) => c.label === 'test#1'), 'test#1');
  assertNotInjected(calls.find((c) => c.label === 'eval#1'), 'eval#1');
});

// (2) Validate red→green-fix 経路
test('[context7-best-practice] green-fix#1 prompt に含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'context7-greenfix');
  assertInjected(calls.find((c) => c.label === 'green-fix#1'), 'green-fix#1');
});

// (3) Evaluate implementation 差し戻し経路
test('[context7-best-practice] fix#1 prompt に含まれ、eval#1 / eval#2 には含まれない', async () => {
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
  assertNoCrash(error, 'context7-fix');
  assertInjected(calls.find((c) => c.label === 'fix#1'), 'fix#1');
  assertNotInjected(calls.find((c) => c.label === 'eval#1'), 'eval#1');
  assertNotInjected(calls.find((c) => c.label === 'eval#2'), 'eval#2');
});

// (4) 定義が inline 生成区間外にあること（inline 生成区間の整合）
test('[context7-best-practice] 定数定義が inline 生成区間外（最後の END inline マーカーより後）にある', () => {
  const defIndex = src.indexOf('const CONTEXT7_BEST_PRACTICE_CONVENTION');
  assert.ok(defIndex !== -1, 'CONTEXT7_BEST_PRACTICE_CONVENTION の定義が見つからない');
  const lastEndIdx = src.lastIndexOf('// ==== END inline:');
  assert.ok(lastEndIdx !== -1, 'dev-flow.js に END inline マーカーが見つからない');
  assert.ok(defIndex > lastEndIdx, `CONTEXT7_BEST_PRACTICE_CONVENTION の定義（index ${defIndex}）が最後の END inline マーカー（index ${lastEndIdx}）より前にある — inline 生成区間内への誤配置の疑い`);
});
