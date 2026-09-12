// Setup(deps) routing test（issue #291）: dev-flow.js の Setup phase に配線された
// worktree-deps exec-proxy 呼び出しを VM sandbox で pin する。
// implementer-staging-convention.test.mjs Part 2 の makeCountingSandbox / runDevFlowInSandbox
// パターンをコピーし、label === 'worktree-deps' への応答をテストケースごとに差し替える。
//
// このテストは:
//   (a) worktree-deps が {status:'failed',...} を返す → workflow が throw せず完走し、
//       implementer prompt 全件に canonical summarizeDepsResult().implNote が含まれる
//   (b) worktree-deps が {status:'no_dependencies'} を返す → canonical implNote は null（no-op）。
//       failed ケース由来の implNote（データ echo）が漏れ込んでいないことを負の証拠にする
//   (c) worktree-deps が null を返す（schema 不一致 drop 相当）→ workflow が throw せず完走し
//       （fail-open）、implementer prompt に canonical summarizeDepsResult(null).implNote が含まれる
//   (d) VM routing: 'worktree-deps' call が namespaced agentType 'dev-flow:dev-runner-haiku' で
//       記録される（旧 source pin を挙動検証へ置換）
//   (e) routing: 'worktree-deps' call が worktree call の後・analyze call の前に記録される
// を assert する（implementer prompt への文言 pin は canonical export 由来の期待値に統一し、
// 言い回し変更のみでは落ちないようにする。issue #636 AC-1）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { summarizeDepsResult } from './setup-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

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

    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
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
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    if (agentType === 'dev-flow:dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 'T1', desc: 'impl', file_changes: ['src/a.ts'], test_plan: 'none', depends_on: [] }],
        parallel: [],
      };
    }
    if (agentType === 'dev-flow:plan-reviewer') {
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
    if (agentType === 'dev-flow:evaluator') {
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
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'done', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
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

// (a) worktree-deps が failed を返す → workflow 完走 + implementer prompt に canonical
// summarizeDepsResult().implNote（言い回し変更で落ちない — canonical export 由来の期待値）が注入される
test('[setup-deps-routing] (a) worktree-deps failed → workflow 完走 & implementer prompt 全件に summarizeDepsResult().implNote が含まれる', async () => {
  const depsResponse = {
    status: 'failed',
    path: '/tmp/wt',
    results: [{ ecosystem: 'node', pm: 'npm', status: 'failed', command: 'npm ci' }],
  };
  const expectedNote = summarizeDepsResult(depsResponse).implNote;
  assert.ok(typeof expectedNote === 'string' && expectedNote.length > 0, 'summarizeDepsResult(failed).implNote は非空文字列のはず');

  const { ctx, calls } = makeCountingSandbox(depsResponse);
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(
      c.prompt.includes(expectedNote),
      `implementer prompt (label=${c.label}) に summarizeDepsResult(failed).implNote が含まれない`,
    );
  }
});

// (b) worktree-deps が no_dependencies を返す → canonical implNote は null（no-op）。
// 負の証拠として (a) の failed ケース由来 implNote（データ echo）が漏れ込んでいないことを確認する。
test('[setup-deps-routing] (b) worktree-deps no_dependencies → canonical implNote:null で implementer prompt に依存警告が注入されない', async () => {
  const noDepResponse = { status: 'no_dependencies' };
  assert.equal(summarizeDepsResult(noDepResponse).implNote, null, 'summarizeDepsResult(no_dependencies).implNote は null のはず');

  const failedNote = summarizeDepsResult({
    status: 'failed',
    path: '/tmp/wt',
    results: [{ ecosystem: 'node', pm: 'npm', status: 'failed', command: 'npm ci' }],
  }).implNote;

  const { ctx, calls } = makeCountingSandbox(noDepResponse);
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(
      !c.prompt.includes(failedNote),
      `implementer prompt (label=${c.label}) に failed ケース由来の依存警告が含まれてはいけない（no_dependencies）`,
    );
  }
});

// (c) worktree-deps が null（schema 不一致 drop 相当）→ fail-open で完走 + canonical
// summarizeDepsResult(null).implNote（'unverified' 経路）が注入される
test('[setup-deps-routing] (c) worktree-deps null（drop 相当）→ fail-open で完走 & implementer prompt に summarizeDepsResult(null).implNote が含まれる', async () => {
  const expectedNote = summarizeDepsResult(null).implNote;
  assert.ok(typeof expectedNote === 'string' && expectedNote.length > 0, 'summarizeDepsResult(null).implNote は非空文字列のはず');

  const { ctx, calls } = makeCountingSandbox(null);
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(
      c.prompt.includes(expectedNote),
      `implementer prompt (label=${c.label}) に summarizeDepsResult(null).implNote が含まれない（fail-open 経路）`,
    );
  }
});

// (d) VM routing: worktree-deps call が namespaced agentType 'dev-flow:dev-runner-haiku' で
// 呼ばれる（旧 source pin（inline マーカー + label 静的走査）を挙動検証へ置換。issue #636 AC-1）
test("[setup-deps-routing] (d) worktree-deps call が label:'worktree-deps' + agentType:'dev-flow:dev-runner-haiku' で記録される", async () => {
  const { ctx, calls } = makeCountingSandbox({ status: 'no_dependencies' });
  const { error } = await runDevFlowInSandbox(src, ctx);
  assertNoCrash(error);

  assert.ok(
    calls.some((c) => c.label === 'worktree-deps' && c.agentType === 'dev-flow:dev-runner-haiku'),
    `calls に label:'worktree-deps' + agentType:'dev-flow:dev-runner-haiku' の呼び出しが無い: ${JSON.stringify(calls.map((c) => ({ label: c.label, agentType: c.agentType })))}`,
  );
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
