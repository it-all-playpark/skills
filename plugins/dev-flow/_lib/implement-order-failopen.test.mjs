// runImplement の spawn 形と fail-open 化を dev-flow.js 全体の VM 実行で pin する
// （issue #534 で fail-open を確立、issue #673 で parallel fan-out / pipeline() を撤去し
// dev-implement-fable の単一 serial spawn へ簡約）。
//
// このテストは dev-flow.js を VM で実行し、agent() 呼び出し列・run の完走・log で検証する:
//   (a) Implement の spawn は impl:serial:issue-<N> の 1 回のみで、:par: label は観測されない
//   (b) dev-implement-fable が throw しても run は abort せず完走する（failOpenAgent による fail-open）
//   (c) sandbox に parallel() / pipeline() が無くても run が完走する（production で両者を使わない）
//   (d) 返却 null は drop 1 として log され、implDroppedCount に計上される（micro で evaluator 強制）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const MICRO_REQ = { summary: 's', acceptance_criteria: ['a'], issue_type: 'fix', scope: 'src', issue_number: 1, issue_title: 'stub-issue-title' };

test('[implement-order-failopen] (a) Implement の spawn は impl:serial:issue-1 の 1 回のみ（parallel fan-out なし）', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.equal(error, null, `(a) run が throw した: ${error?.message}`);
  const impl = calls.filter((c) => c.label.startsWith('impl:'));
  assert.deepEqual(impl.map((c) => c.label), ['impl:serial:issue-1'], `(a) Implement の spawn 列が想定と異なる: ${impl.map((c) => c.label).join(', ')}`);
  assert.equal(impl[0].agentType, 'dev-flow:dev-implement-fable', `(a) agentType が ${impl[0].agentType}`);
  assert.equal(calls.filter((c) => c.label.includes(':par:')).length, 0, '(a) parallel fan-out の label（:par:）が観測された');
});

test('[implement-order-failopen] (b) dev-implement-fable の throw は run を abort させない（fail-open）', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { 'impl:serial:issue-1': () => { throw new Error('stub throw for issue-1'); } },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.equal(error, null, `(b) throw で run が abort した（fail-open 化されていない。issue #534 AC-2）: ${error?.message}`);
  assert.ok(result !== null, '(b) run は return object を返すべき');
  assert.ok(calls.some((c) => c.label === 'impl:serial:issue-1'), '(b) impl:serial:issue-1 が呼ばれていない');
  assert.ok(logs.some((l) => l.includes('impl: dev-implement-fable 1 件が失敗(null)')), `(b) fail-open の drop 警告 log が無い: ${JSON.stringify(logs.filter((l) => l.includes('失敗')))}`);
});

test('[implement-order-failopen] (c) sandbox に parallel() / pipeline() が無くても run が完走する（production で両者不使用）', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { parallel: undefined, pipeline: undefined } });
  assert.equal(typeof ctx.parallel, 'undefined');
  assert.equal(typeof ctx.pipeline, 'undefined');
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.equal(error, null, `(c) parallel()/pipeline() 不在で run が失敗した — production の呼び出しが残存している: ${error?.message}`);
  assert.equal(calls.filter((c) => c.label === 'impl:serial:issue-1').length, 1, '(c) dev-implement-fable が 1 回実行されるはず');
});

test('[implement-order-failopen] (d) 返却 null は drop 1 として計上され、micro でも evaluator が強制される', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { 'analyze#1': MICRO_REQ, 'impl:serial:issue-1': null } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.equal(error, null, `(d) null 返却で run が throw した: ${error?.message}`);
  assert.ok(logs.some((l) => l.includes('implement drop 1 件')), `(d) implDroppedCount=1 の log が無い: ${JSON.stringify(logs.filter((l) => l.includes('drop')))}`);
  assert.ok(calls.filter((c) => c.agentType === 'dev-flow:evaluator').length >= 1, '(d) drop 発生時は micro でも evaluator が起動するはず');
});
