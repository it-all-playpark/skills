// Unit tests for _lib/test-helpers/vm-sandbox.mjs and _lib/test-helpers/dev-flow-markers.mjs
// TDD: このファイルを先に書き、モジュール未作成の状態で red → モジュール実装後 green になることを確認する。
//
// Placement: _lib 直下フラット配置（AC#3 の `node --test _lib/*.test.mjs` glob に乗せるため）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

import { makeRecordingSandbox, runDevFlowInSandbox, JS_GLOBALS } from './test-helpers/vm-sandbox.mjs';
import { TEST_WEAKENING } from './test-helpers/dev-flow-markers.mjs';

// ============================================================
// makeRecordingSandbox: calls 記録 / responder 委譲
// ============================================================

test('[test-helpers] makeRecordingSandbox: {ctx, calls} を返すこと', () => {
  const responder = () => ({ result: 'ok' });
  const { ctx, calls } = makeRecordingSandbox(responder);
  assert.ok(ctx != null, 'ctx が返されること');
  assert.ok(Array.isArray(calls), 'calls が配列であること');
});

test('[test-helpers] makeRecordingSandbox: agent() 呼び出しが calls に記録されること', async () => {
  const responder = ({ label, agentType, prompt }) => ({ label, agentType, prompt });
  const { ctx, calls } = makeRecordingSandbox(responder);

  // ctx 経由で agent を呼ぶ — vm.runInContext で呼び出す
  const script = new vm.Script(`agent('P', { label: 'x', agentType: 'y' })`);
  const resultPromise = script.runInContext(ctx);
  await resultPromise;

  assert.equal(calls.length, 1, 'calls に 1 件記録されること');
  assert.deepEqual(calls[0], { label: 'x', agentType: 'y', prompt: 'P' });
});

test('[test-helpers] makeRecordingSandbox: responder の返り値が agent() の返り値になること', async () => {
  const responder = () => ({ status: 'DONE', task_id: 't1' });
  const { ctx } = makeRecordingSandbox(responder);

  const script = new vm.Script(`agent('prompt', { label: 'impl', agentType: 'implementer' })`);
  const result = await script.runInContext(ctx);

  assert.deepEqual(result, { status: 'DONE', task_id: 't1' });
});

test('[test-helpers] makeRecordingSandbox: responder が undefined を返したら agent() は null を返すこと', async () => {
  const responder = () => undefined;
  const { ctx } = makeRecordingSandbox(responder);

  const script = new vm.Script(`agent('p', {})`);
  const result = await script.runInContext(ctx);

  assert.equal(result, null);
});

test('[test-helpers] makeRecordingSandbox: opts が省略されても calls に空文字列で記録されること', async () => {
  const responder = () => null;
  const { ctx, calls } = makeRecordingSandbox(responder);

  const script = new vm.Script(`agent('hello')`);
  await script.runInContext(ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, '');
  assert.equal(calls[0].agentType, '');
  assert.equal(calls[0].prompt, 'hello');
});

// ============================================================
// makeRecordingSandbox: JS_GLOBALS と control fns の expose
// ============================================================

test('[test-helpers] makeRecordingSandbox: ctx に JSON が expose されていること', () => {
  const { ctx } = makeRecordingSandbox(() => null);
  // vm.runInContext で JSON.stringify が使えることを確認
  const result = vm.runInContext(`JSON.stringify({a:1})`, ctx);
  assert.equal(result, '{"a":1}');
});

test('[test-helpers] makeRecordingSandbox: ctx に Math が expose されていること', () => {
  const { ctx } = makeRecordingSandbox(() => null);
  const result = vm.runInContext(`Math.max(1, 2)`, ctx);
  assert.equal(result, 2);
});

test('[test-helpers] makeRecordingSandbox: ctx に control fns (phase/log/workflow/args) が expose されていること', () => {
  const { ctx } = makeRecordingSandbox(() => null);

  // phase, log は呼び出せる（void 関数）
  vm.runInContext(`phase('step1')`, ctx);
  vm.runInContext(`log('msg')`, ctx);

  // workflow は async 関数
  const wfType = vm.runInContext(`typeof workflow`, ctx);
  assert.equal(wfType, 'function');

  // args は文字列
  const argsType = vm.runInContext(`typeof args`, ctx);
  assert.equal(argsType, 'string');
});

test('[test-helpers] makeRecordingSandbox: extraSandbox で上書きできること', () => {
  const { ctx } = makeRecordingSandbox(() => null, { args: '999' });
  const result = vm.runInContext(`args`, ctx);
  assert.equal(result, '999');
});

// ============================================================
// JS_GLOBALS: エクスポートされた定数の確認
// ============================================================

test('[test-helpers] JS_GLOBALS: 15 個の組み込みが含まれること', () => {
  const expected = ['console', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Error', 'RegExp', 'Promise', 'Symbol', 'Map', 'Set', 'Date'];
  for (const key of expected) {
    assert.ok(key in JS_GLOBALS, `JS_GLOBALS に ${key} が含まれること`);
  }
  assert.equal(Object.keys(JS_GLOBALS).length, expected.length, `JS_GLOBALS のキーが正確に ${expected.length} 個であること`);
});

// ============================================================
// runDevFlowInSandbox: 最小擬似ソースの strip 実行
// ============================================================

test('[test-helpers] runDevFlowInSandbox: 最小擬似ソースを ReferenceError/SyntaxError なく実行できること', async () => {
  // 最小擬似ソース: export const を含む変数宣言と agent 呼び出し
  const minimalSrc = `export const X = 1;\nawait agent('p', {label:'worktree'});\n`;
  const responder = () => ({ worktree: '/tmp/wt', branch: 'feature/test' });
  const { ctx } = makeRecordingSandbox(responder);

  const err = await runDevFlowInSandbox(minimalSrc, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`runDevFlowInSandbox が ${err.name} を throw した: ${err.message}`);
  }
});

test('[test-helpers] runDevFlowInSandbox: export function を strip して関数が呼び出せること', async () => {
  const src = `export function greet() { return 'hello'; }\nconst r = greet();\n`;
  const { ctx } = makeRecordingSandbox(() => null);

  const err = await runDevFlowInSandbox(src, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`runDevFlowInSandbox が ${err.name} を throw した: ${err.message}`);
  }
});

test('[test-helpers] runDevFlowInSandbox: 実際の dev-flow.js ソースを ReferenceError/SyntaxError なく実行できること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  // 最小限のレスポンダー（全 label に対して適切な応答）
  const responder = ({ label, agentType }) => {
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return { summary: 's', acceptance_criteria: ['a'], issue_type: 'fix', scope: 'src', estimated_change_file_count: 1, shape: 'micro' };
    if (agentType === 'dev-planner') return { summary: 'p', serial: [], parallel: [] };
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (agentType === 'evaluator') return { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [] };
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') return { files: [] };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    return null;
  };
  const { ctx } = makeRecordingSandbox(responder);

  const err = await runDevFlowInSandbox(src, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }
});

// ============================================================
// TEST_WEAKENING: 非空 + dev-flow.js source 包含の pin
// ============================================================

test('[test-helpers] TEST_WEAKENING: 空文字でないこと', () => {
  assert.ok(typeof TEST_WEAKENING === 'string', 'TEST_WEAKENING は string 型であること');
  assert.ok(TEST_WEAKENING.length > 0, 'TEST_WEAKENING は空文字でないこと');
});

test('[test-helpers] TEST_WEAKENING: dev-flow.js ソースに含まれること（canonical source との pin）', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes(TEST_WEAKENING),
    `dev-flow.js ソースに TEST_WEAKENING ('${TEST_WEAKENING}') が含まれること`,
  );
});
