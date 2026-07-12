// dev-flow-canary.js の VM sandbox routing test（TDD red として先に作成）。
//
// dev-flow-canary.js はまだ存在しない（このテストが先に red になることを確認してから実装する）。
// shape-loop-routing.test.mjs / workflow-load-smoke.test.mjs と同型の VM sandbox パターンで、
// agent()/parallel()/workflow() を stub し、workflow 本体の戻り値（report）を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canaryPath = join(repoRoot, '.claude/workflows/dev-flow-canary.js');

const EXPECTED_CAPABILITY_IDS = [
  'agent_schema',
  'model_routing',
  'effort_routing',
  'parallel_fanout',
  'nested_workflow',
  'pause_resume',
  'direct_fs',
  'direct_shell',
  'direct_import',
];

// ---- agent() stub 生成 -----------------------------------------------------------------------
//
// label ごとの既定 happy-path 応答 + overrideMap による上書き（null や別 shape を注入できる）。

function defaultAgentReturn(label) {
  if (label === 'canary:version') {
    return { ok: true, version: '2.1.99', timestamp_utc: '2026-07-13T00:00:00Z' };
  }
  if (label === 'canary:model-report') {
    return { model_id: 'claude-haiku-4-5' };
  }
  if (label.startsWith('canary:par:')) {
    const token = label.slice('canary:par:'.length);
    return { ok: true, token };
  }
  if (label === 'canary:report-write') {
    return { ok: true, path: '/home/u/.claude/logs/dev-flow-canary/canary-1.json' };
  }
  return null;
}

function makeAgentStub(overrideMap = {}) {
  const calls = [];
  const stub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });
    if (Object.prototype.hasOwnProperty.call(overrideMap, label)) {
      const v = overrideMap[label];
      return typeof v === 'function' ? v(prompt, opts) : v;
    }
    return defaultAgentReturn(label);
  };
  return { stub, calls };
}

/**
 * dev-flow-canary 専用の VM sandbox を組む。
 * require/process/Buffer/globalThis.pause 等は意図的に注入しない
 * （direct_fs/direct_shell/direct_import/pause_resume が unsupported になることを確認するため）。
 *
 * @param {object} opts
 * @param {object} [opts.agentOverrides] - label -> 返り値（または (prompt,opts)=>値 の関数）
 * @param {Function} [opts.workflowImpl] - workflow() stub（既定は nested child の happy-path）
 */
function makeCanarySandbox({ agentOverrides = {}, workflowImpl } = {}) {
  const { stub: agentStub, calls } = makeAgentStub(agentOverrides);
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const defaultWorkflow = async () => ({ child_ok: true, echo: 'canary-nested-probe' });
  const workflowStub = workflowImpl ?? defaultWorkflow;

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    args: '',
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

/**
 * dev-flow-canary.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * IIFE の resolve 値（= workflow の `return report`）を捕捉する。
 *
 * @returns {Promise<{result: any, error: Error|null}>}
 */
async function runCanaryInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let result = null;
  let error = null;
  try {
    const p = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow-canary.js' });
    if (p && typeof p.then === 'function') {
      result = await p.catch((e) => {
        error = e;
        return null;
      });
    } else {
      result = p;
    }
  } catch (e) {
    error = e;
  }
  return { result, error };
}

function assertNoStructuralError(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow-canary.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

function findCap(report, id) {
  return report.capabilities.find((c) => c.id === id);
}

// ============================================================
// 1. Happy path
// ============================================================

test('[canary] happy path: 9 capability が全て enum 内・agent/model/parallel/nested=pass・direct系/pause/effort=unsupported', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox();
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'report が return されること');

  const report = result;

  assert.equal(report.canary_version, '1.0.0');
  assert.equal(report.claude_code_version, '2.1.99');

  assert.ok(Array.isArray(report.capabilities));
  assert.equal(report.capabilities.length, 9, 'capabilities は正確に9件であること');

  // report.capabilities は vm sandbox（別 realm）内で生成された配列のため、.map()/.sort() を
  // そのまま呼ぶと結果が sandbox realm の Array のままになり、deepStrictEqual が
  // prototype 不一致で false 判定してしまう。Array.from（host realm の Array を明示的に呼ぶ）で
  // host realm の配列へ変換してから比較する。
  const actualIds = Array.from(report.capabilities, (c) => c.id).sort();
  const expectedIds = Array.from(EXPECTED_CAPABILITY_IDS).sort();
  assert.deepEqual(actualIds, expectedIds, 'capability id set が期待の9個と一致すること');

  for (const c of report.capabilities) {
    assert.ok(['pass', 'fail', 'unsupported'].includes(c.status), `id=${c.id} の status が enum 内であること (got ${c.status})`);
    assert.equal(typeof c.detail, 'string', `id=${c.id} の detail が string であること`);
  }

  assert.equal(findCap(report, 'agent_schema').status, 'pass');
  assert.equal(findCap(report, 'model_routing').status, 'pass');
  assert.equal(findCap(report, 'parallel_fanout').status, 'pass');
  assert.equal(findCap(report, 'nested_workflow').status, 'pass');
  assert.equal(findCap(report, 'effort_routing').status, 'unsupported');
  assert.equal(findCap(report, 'direct_fs').status, 'unsupported');
  assert.equal(findCap(report, 'direct_shell').status, 'unsupported');
  assert.equal(findCap(report, 'direct_import').status, 'unsupported');
  assert.equal(findCap(report, 'pause_resume').status, 'unsupported');

  assert.equal(report.bridge_sunset.exec_proxy_removable, false);
  assert.equal(report.bridge_sunset.inline_generator_removable, false);
  assert.equal(report.bridge_sunset.verdict, 'keep-bridges');
  assert.equal(
    report.bridge_sunset.note,
    'capability report only — bridge 撤去は別 issue + human review でのみ実施',
  );

  assert.equal(report.report_path, '/home/u/.claude/logs/dev-flow-canary/canary-1.json');
});

// ============================================================
// 2. 全 stub null（load-smoke 同等）— throw せず report が返る
// ============================================================

test('[canary] 全 stub null: throw せず report が return され、主要 capability が fail・claude_code_version=unknown・report_path=null', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:version': null,
      'canary:model-report': null,
      'canary:par:A': null,
      'canary:par:B': null,
      'canary:report-write': null,
    },
    workflowImpl: async () => null,
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'null stub でも report が return されること（throw しない）');

  const report = result;
  assert.equal(findCap(report, 'agent_schema').status, 'fail');
  assert.equal(findCap(report, 'model_routing').status, 'fail');
  assert.equal(findCap(report, 'parallel_fanout').status, 'fail');
  assert.equal(findCap(report, 'nested_workflow').status, 'fail');
  assert.equal(report.claude_code_version, 'unknown');
  assert.equal(report.report_path, null);
});

// ============================================================
// 3. workflow() が throw する → nested_workflow=unsupported
// ============================================================

test('[canary] workflow() が throw する場合 nested_workflow=unsupported', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    workflowImpl: async () => {
      throw new Error('nested workflow not supported in this harness');
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'nested_workflow').status, 'unsupported');
  assert.match(findCap(result, 'nested_workflow').detail, /threw/);
});

// ============================================================
// 4. model_id が haiku 系でない場合 model_routing=fail
// ============================================================

test('[canary] model-report が非haiku model_id を返すと model_routing=fail', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:model-report': { model_id: 'claude-sonnet-4-5' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'model_routing').status, 'fail');
});

// ============================================================
// 5. source lint（read-only 保証 / agentType 制限 / top-level require 不在）
// ============================================================

test('[canary][lint] mutating git/gh コマンドが source に存在しない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  assert.ok(!/git +(commit|push|add|worktree)/.test(src), 'mutating git コマンドが含まれないこと');
  assert.ok(!/\bgh (pr|issue|api)/.test(src), 'gh pr/issue/api コマンドが含まれないこと');
});

test('[canary][lint] agentType は dev-runner-haiku-ro / dev-runner-haiku のみ', () => {
  const src = readFileSync(canaryPath, 'utf8');
  const matches = [...src.matchAll(/agentType:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, '少なくとも1つの agentType 指定があること');
  for (const at of matches) {
    assert.ok(
      at === 'dev-runner-haiku-ro' || at === 'dev-runner-haiku',
      `想定外の agentType が使われている: ${at}`,
    );
  }
});

test('[canary][lint] module top-level に require() が存在しない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  const lines = src.split('\n');
  const violations = lines.filter((l) => /^(?:const|let|var)\s+\S+\s*=\s*require\s*\(/.test(l) || /^require\s*\(/.test(l));
  assert.deepEqual(violations, [], 'module top-level に require() が存在しないこと');
});

test('[canary][lint] module top-level に Date.now() initializer が存在しない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  const lines = src.split('\n');
  const violations = lines.filter((l) => /^(?:const|let|var)\s+\S+\s*=.*\bDate\.now\s*\(/.test(l));
  assert.deepEqual(violations, [], 'module top-level に Date.now() initializer が存在しないこと');
});
