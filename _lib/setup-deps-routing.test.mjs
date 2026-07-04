// Setup(deps) routing test（issue #291）: dev-flow.js の Setup phase に配線された
// worktree-deps exec-proxy 呼び出しを VM sandbox で pin する。
// implementer-staging-convention.test.mjs Part 2 の makeCountingSandbox / runDevFlowInSandbox
// パターンをコピーし、label === 'worktree-deps' への応答をテストケースごとに差し替える。
//
// このテストは:
//   (a) worktree-deps が {status:'failed',...} を返す → workflow が throw せず完走し、
//       implementer prompt 全件に『依存インストール警告』が含まれる
//   (b) worktree-deps が {status:'no_dependencies'} を返す → implementer prompt に
//       『依存インストール警告』が含まれない（no-op で既存挙動不変）
//   (c) worktree-deps が null を返す（schema 不一致 drop 相当）→ workflow が throw せず完走し
//       （fail-open）、implementer prompt に『依存インストール警告』が含まれる
//   (d) source pin: dev-flow.js に inline マーカーと label:'worktree-deps' の agent 呼び出しが存在する
//   (e) routing: 'worktree-deps' call が worktree call の後・analyze call の前に記録される
// を assert する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// Part 1: source pin
// ============================================================

test('[setup-deps-routing] dev-flow.js に _lib/setup-deps.mjs の inline マーカーが存在する', () => {
  assert.ok(
    src.includes('// ==== BEGIN inline: _lib/setup-deps.mjs'),
    'dev-flow.js に "// ==== BEGIN inline: _lib/setup-deps.mjs" マーカーが存在しない',
  );
  assert.ok(
    src.includes('// ==== END inline: _lib/setup-deps.mjs ===='),
    'dev-flow.js に "// ==== END inline: _lib/setup-deps.mjs ====" マーカーが存在しない',
  );
});

test('[setup-deps-routing] dev-flow.js に label:\'worktree-deps\' の agent 呼び出しが存在する（agentType dev-runner-haiku）', () => {
  assert.ok(
    src.includes("label: 'worktree-deps'"),
    'dev-flow.js に "label: \'worktree-deps\'" が存在しない',
  );
  const idx = src.indexOf("label: 'worktree-deps'");
  // 呼び出し全体（1000 文字程度手前まで遡って agentType を探す）を確認
  const windowStart = Math.max(0, idx - 1000);
  const window = src.slice(windowStart, idx + 200);
  assert.ok(
    window.includes("agentType: 'dev-runner-haiku'"),
    'label:\'worktree-deps\' の周辺に agentType: \'dev-runner-haiku\' が見つからない',
  );
});

// ============================================================
// Part 2: behavioral routing（VM sandbox）
// implementer-staging-convention.test.mjs の makeCountingSandbox / runDevFlowInSandbox と同型。
// label === 'worktree-deps' の応答をテストケースごとに差し替えられるようにする。
// ============================================================

/**
 * @param {*} depsResponse worktree-deps call への応答（null 可）
 */
function makeCountingSandbox(depsResponse) {
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt) });

    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label === 'worktree-deps') {
      return depsResponse;
    }
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a', 'b', 'c'],
        issue_type: 'feat',
        scope: 'src',
        estimated_change_file_count: 3,
        shape: 'standard',
      };
    }
    if (agentType === 'dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 'T1', desc: 'impl', file_changes: ['src/a.ts'], test_plan: 'none', depends_on: [] }],
        parallel: [],
      };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label === 'realized-diff') {
      return { files: ['src/a.ts', 'src/b.ts'] };
    }
    if (label === 'declared-path-check') {
      return { files: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/a.ts'] };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'done', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: '1',
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

async function runDevFlowInSandbox(source, ctx) {
  const stripped = source
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = '(async () => {\n' + stripped + '\n})();';

  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }
}

// (a) worktree-deps が failed を返す → workflow 完走 + implementer prompt に警告注入
test('[setup-deps-routing] (a) worktree-deps failed → workflow 完走 & implementer prompt 全件に依存インストール警告', async () => {
  const depsResponse = {
    status: 'failed',
    path: '/tmp/wt',
    results: [{ ecosystem: 'node', pm: 'npm', status: 'failed', command: 'npm ci' }],
  };
  const { ctx, calls } = makeCountingSandbox(depsResponse);
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(
      c.prompt.includes('依存インストール警告'),
      `implementer prompt (label=${c.label}) に '依存インストール警告' が含まれない`,
    );
  }
});

// (b) worktree-deps が no_dependencies を返す → implementer prompt に警告なし（no-op）
test('[setup-deps-routing] (b) worktree-deps no_dependencies → implementer prompt に依存インストール警告なし', async () => {
  const { ctx, calls } = makeCountingSandbox({ status: 'no_dependencies' });
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(
      !c.prompt.includes('依存インストール警告'),
      `implementer prompt (label=${c.label}) に '依存インストール警告' が含まれてはいけない（no_dependencies）`,
    );
  }
});

// (c) worktree-deps が null（schema 不一致 drop 相当）→ fail-open で完走 + 警告注入
test('[setup-deps-routing] (c) worktree-deps null（drop 相当）→ fail-open で完走 & implementer prompt に依存インストール警告', async () => {
  const { ctx, calls } = makeCountingSandbox(null);
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(
      c.prompt.includes('依存インストール警告'),
      `implementer prompt (label=${c.label}) に '依存インストール警告' が含まれない（fail-open 経路）`,
    );
  }
});

// (e) routing: worktree-deps call が worktree call の後・analyze call の前に記録される
test('[setup-deps-routing] (e) worktree-deps call の順序が worktree の後・analyze の前', async () => {
  const { ctx, calls } = makeCountingSandbox({ status: 'no_dependencies' });
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const worktreeIdx = calls.findIndex((c) => c.label === 'worktree');
  const depsIdx = calls.findIndex((c) => c.label === 'worktree-deps');
  const analyzeIdx = calls.findIndex((c) => c.label.startsWith('analyze'));

  assert.notEqual(worktreeIdx, -1, 'worktree call が見つからない');
  assert.notEqual(depsIdx, -1, 'worktree-deps call が見つからない');
  assert.notEqual(analyzeIdx, -1, 'analyze call が見つからない');
  assert.ok(depsIdx > worktreeIdx, 'worktree-deps は worktree の後に呼ばれるべき');
  assert.ok(depsIdx < analyzeIdx, 'worktree-deps は analyze の前に呼ばれるべき');
});
