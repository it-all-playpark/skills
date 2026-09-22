// blocked-done-preservation.test.mjs — BLOCKED 再実装後の結果マージ保持を VM sandbox で検証する
// （issue #673 で dev-implement-fable 一本の経路に追随）。
//
//   (a) reimpl-blocked#1 が DONE_WITH_CONCERNS を返したら b=2 は発火しない
//       （stale な BLOCKED を implResults に残さない）
//   (b) 再実装の concerns が evaluator の focus_areas へ伝搬する（DONE 結果のマージ保持）
//   (c) 再実装の返却 files が宣言として取り込まれ、宣言外変更 concern が出ない
//   (d) 単一 task の合成 plan では再 spawn 時点で DONE 成果は存在しない — prompt に「適用済み成果」節が
//       付かない（付くのは DONE を持つ task が別にある場合のみ）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, STANDARD_FILES } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

// 実効 shape は既定 responder の realized 3 件（STANDARD_FILES）+ AC 4 で standard（issue #676）
const STANDARD_REQ = {
  summary: 's', acceptance_criteria: ['a', 'b', 'c', 'd'], issue_type: 'fix', scope: 'src',
  issue_number: 1, issue_title: 'stub-issue-title',
};

test('[blocked-done-preservation] BLOCKED → reimpl-blocked#1 DONE_WITH_CONCERNS: b=2 は発火せず、concerns と files が保持される', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'analyze#1': STANDARD_REQ,
      'impl:serial:issue-1': {
        status: 'BLOCKED', task_id: 'issue-1', files: [], summary: '', concerns: [],
        blocking_reason: { block_class: 'approach_mismatch', detail: 'RZ: lib-z api missing' },
      },
      'reimpl-blocked#1:serial:issue-1': {
        status: 'DONE_WITH_CONCERNS', task_id: 'issue-1', files: [...STANDARD_FILES],
        summary: 'implemented via lib-y', concerns: ['issue-1-concern: null handling unverified'],
      },
    },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'blocked-done-preservation');
  assert.equal(error, null, `run が throw した: ${error?.message}`);

  const rb = calls.filter((c) => c.label.startsWith('reimpl-blocked#'));
  // (a) b=2 は発火しない
  assert.deepEqual(rb.map((c) => c.label), ['reimpl-blocked#1:serial:issue-1'], `reimpl-blocked#1 の DONE 後に b=2 が発火した: ${rb.map((c) => c.label).join(', ')}`);
  assert.ok(!logs.some((m) => m.includes('回再実装しても')), 'DONE で解消したのに BLOCK_MAX 到達 log が出た');

  // (b) concerns の Evaluate 伝搬
  const ev = calls.find((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(ev, 'evaluator が起動していない');
  assert.ok(ev.prompt.includes('issue-1-concern: null handling unverified'), `再実装の concerns が evaluator prompt に伝搬していない。prompt[:800]: ${ev.prompt.slice(0, 800)}`);
  assert.ok(!ev.prompt.includes('approach_mismatch(issue-1)'), '解消済み BLOCKED が approach_mismatch concern として残っている');

  // (c) 返却 files の宣言取り込み
  assert.ok(logs.some((l) => l.includes('宣言外変更なし')), `再実装の返却 files が宣言として取り込まれていない: ${logs.filter((l) => l.includes('宣言外')).join(' | ')}`);

  // (d) 単一 task では DONE 成果節は付かない（findings 節は付く）
  assert.ok(rb[0].prompt.includes('approach_mismatch findings'), 'reimpl-blocked#1 prompt に findings 節が無い');
  assert.ok(!rb[0].prompt.includes('適用済み成果'), '単一 task の再 spawn prompt に「適用済み成果」節が付いている（DONE 成果は存在しないはず）');

  assert.ok(result?.pr_url != null, `完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)}`);
});
