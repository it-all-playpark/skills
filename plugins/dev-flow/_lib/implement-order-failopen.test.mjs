// runImplement の実行順（parallel → serial）と fail-open 化を dev-flow.js 全体の VM 実行で pin する
// （issue #534 で確立、issue #332 で parallel fan-out を pipeline() へ移行、issue #636 で
// runImplement 窓のソース切り出し + 文字列 pin を撤去し全体 VM 実行へ統一）。
//
// 背景（issue #534）:
//   従来の runImplement は plan.serial を先に順次実行し、plan.parallel を後に fan-out していた。
//   dev-planner の定義（serial=依存あり / parallel=独立）と整合させるには、独立している parallel を
//   先に実行し、serial がその成果物に依存できるようにする必要がある（AC-1）。
//   また serial 側は trackedAgent を直接呼んでおり、implementer が throw すると run 全体が abort
//   していた。parallel 側と同様に failOpenAgent（throw→null 吸収）へ合流させる（AC-2）。
//
// 背景（issue #332）:
//   parallel 側の fan-out を独自 parallel(thunks) から harness-native の pipeline(items, callback) へ
//   移行した。pipeline() は canary 実測契約（Claude Code 2.1.252、issue #325/#560 canary）により
//   callback の throw / null return を reject せず per-item null で resolve する。
//
// このテストは dev-flow.js を VM で実行し、agent() 呼び出し順・run の完走・返り値で検証する:
//   (a) parallel task（impl:par:*）の呼び出しが serial task（impl:serial:*）より先に観測される
//   (b) serial implementer が throw しても run は abort せず完走する（fail-open）
//   (c) sandbox から parallel() を外しても run が完走する（production parallel() 不使用、issue #332 AC-10）
//   (d) plan.serial / plan.parallel が空でも implementer 0 回で run が完走する

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const MIXED_PLAN = {
  summary: 'p',
  serial: [{ id: 'S1', desc: 'd', file_changes: ['src/s1.ts'], test_plan: 'tp', depends_on: ['P1'] }],
  parallel: [
    { id: 'P1', desc: 'd', file_changes: ['src/p1.ts'], test_plan: 'tp', depends_on: [] },
    { id: 'P2', desc: 'd', file_changes: ['src/p2.ts'], test_plan: 'tp', depends_on: [] },
  ],
};

function implDone(taskId, files) {
  return { status: 'DONE', task_id: taskId, files, summary: 's', concerns: [] };
}

const MIXED_OVERRIDES = {
  'plan#standard': MIXED_PLAN,
  'impl:par:P1': implDone('P1', ['src/p1.ts']),
  'impl:par:P2': implDone('P2', ['src/p2.ts']),
  'impl:serial:S1': implDone('S1', ['src/s1.ts']),
  'danger-grep': { risk: { ok: true, hits: [] }, files: ['src/p1.ts', 'src/p2.ts', 'src/s1.ts'], struct: null, diffhash: { hash: 'AAA', empty: false } },
  'changed-files': { files: ['src/p1.ts', 'src/p2.ts', 'src/s1.ts'] },
};

test('[implement-order-failopen] (a) parallel task の呼び出しが serial task より先に観測される', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: MIXED_OVERRIDES });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.equal(error, null, `(a) run が throw した: ${error?.message}`);

  const p1 = calls.findIndex((c) => c.label === 'impl:par:P1');
  const p2 = calls.findIndex((c) => c.label === 'impl:par:P2');
  const s1 = calls.findIndex((c) => c.label === 'impl:serial:S1');
  assert.ok(p1 >= 0 && p2 >= 0 && s1 >= 0, `(a) impl 呼び出しが揃わない: ${calls.map((c) => c.label).filter((l) => l.startsWith('impl:')).join(', ')}`);
  assert.ok(p1 < s1 && p2 < s1, `(a) parallel（${p1}, ${p2}）は serial（${s1}）より先に呼ばれるべき（issue #534 AC-1）`);
});

test('[implement-order-failopen] (b) serial implementer の throw は run を abort させない（fail-open）', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { ...MIXED_OVERRIDES, 'impl:serial:S1': () => { throw new Error('stub throw for S1'); } },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.equal(error, null, `(b) serial throw で run が abort した（fail-open 化されていない。issue #534 AC-2）: ${error?.message}`);
  assert.ok(result !== null, '(b) run は return object を返すべき');
  assert.ok(calls.some((c) => c.label === 'impl:serial:S1'), '(b) impl:serial:S1 が呼ばれていない');
  assert.ok(logs.some((l) => l.includes('S1') || l.includes('serial')), `(b) serial 失敗の fail-open 警告 log が無い: ${JSON.stringify(logs.slice(-10))}`);
});

test('[implement-order-failopen] (c) sandbox に parallel() が無くても run が完走する（production parallel() 不使用、issue #332 AC-10）', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: MIXED_OVERRIDES, extra: { parallel: undefined } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.equal(error, null, `(c) parallel() 不在で run が失敗した — production parallel() 呼び出しが残存している: ${error?.message}`);
  assert.equal(calls.filter((c) => c.label.startsWith('impl:par:')).length, 2, '(c) pipeline fan-out で parallel 2 task が実行されるはず');
});

test('[implement-order-failopen] (d) plan.serial / plan.parallel が空でも implementer 0 回で run が完走する', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'plan#standard': { summary: 'p', serial: [], parallel: [] } },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.equal(error, null, `(d) 空 plan で run が throw した: ${error?.message}`);
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:implementer' && c.label.startsWith('impl:')).length, 0, '(d) implementer は 0 回のはず');
});
