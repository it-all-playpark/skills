// implementer.md は sandbox write-deny（issue #216 リトライで実証）のため、規約は dev-flow.js が
// 全 implementer spawn prompt に注入する。本テストはその注入を source + routing の 2 層で pin する。
//
// 問題: implementer が evaluator.staged.md / fm_*.txt 等の一時ファイルを worktree 直下に残すと
//       `git status --porcelain --untracked-files=all` ベースの realized-diff が膨張し、
//       micro→standard の refloor 誤発火や 30 件超の CONCERN スパムが起きる（issue #216）。
//
// このテストは:
//   (1) dev-flow.js に識別子 'STAGING_CONVENTION' がちょうど 5 回出現する
//       （定義 1 + implPrompt/green-fix#i/green-fix#retry-vi/fix#i の 4 usage）
//   (2) STAGING_CONVENTION 定義（source 全体）に '.devflow-tmp' / 'fm_*.txt' / 'staged' が含まれる
//   (3) routing: micro または standard 経路で sandbox 実行し、agentType === 'implementer' の
//       呼び出しが >= 1 件あること
//   (4) routing: 全 implementer call の prompt に '.devflow-tmp' と 'TMPDIR' と 'staged' が含まれる
// を assert する。
// implementer.md は一切読まない（旧テストの readFileSync(implementerMdPath) は完全に廃止）。

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

// (1) STAGING_CONVENTION が dev-flow.js にちょうど 4 回出現する（定義 1 + usage 3）
// F2 (runValidateLoop 統合) 後: green-fix 本経路 + retry 経路が runValidateLoop 内の 1 行に統合
// されたため旧 5 → 4 に変更（implPrompt/runValidateLoop-green-fix/fix の usage 3）。
test('[staging-convention] dev-flow.js に STAGING_CONVENTION がちょうど 4 回出現する', () => {
  const count = src.split('STAGING_CONVENTION').length - 1;
  assert.equal(
    count,
    4,
    `dev-flow.js に STAGING_CONVENTION が ${count} 回出現（期待: 4 回 = 定義 1 + implPrompt/runValidateLoop-green-fix/fix の usage 3）`,
  );
});

// (2) 規約トークン '.devflow-tmp' / 'fm_*.txt' / 'staged' が source に存在する
test('[staging-convention] dev-flow.js に ".devflow-tmp" が含まれる', () => {
  assert.ok(
    src.includes('.devflow-tmp'),
    'dev-flow.js に ".devflow-tmp" が存在しない（STAGING_CONVENTION 定義に含まれるはず）',
  );
});

test('[staging-convention] dev-flow.js に "fm_*.txt" への言及が含まれる', () => {
  assert.ok(
    src.includes('fm_*.txt') || src.includes('fm_'),
    'dev-flow.js に "fm_*.txt" / "fm_" への言及が存在しない（STAGING_CONVENTION 定義に含まれるはず）',
  );
});

test('[staging-convention] dev-flow.js に "staged" への言及が含まれる', () => {
  assert.ok(
    src.includes('staged'),
    'dev-flow.js に "staged" が存在しない（STAGING_CONVENTION 定義に含まれるはず）',
  );
});

// ============================================================
// Part 2: behavioral routing pin（VM sandbox）
// ephemeral-paths-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox と同型。
// agent() stub が calls 配列に { label, agentType, prompt } を記録する。
// ============================================================

/**
 * staging-convention routing 専用の VM sandbox を組む。
 * standard 経路で 1 回実行し、implementer prompt に規約トークンが含まれることを検証する。
 *
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox() {
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

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * ephemeral-paths-routing.test.mjs の runDevFlowInSandbox と同型。
 */
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

// (3) routing: implementer 呼び出しが >= 1 件あること
// (4) routing: 全 implementer call の prompt に '.devflow-tmp' と 'TMPDIR' と 'staged' が含まれる
test('[staging-convention] routing: implementer prompt 全件に規約トークンが含まれる', async () => {
  const { ctx, calls } = makeCountingSandbox();
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const implCalls = calls.filter((c) => c.agentType === 'implementer');

  assert.ok(
    implCalls.length >= 1,
    `implementer が呼ばれていない（0 件）。standard 経路で serial[T1] が実行されるはず`,
  );

  for (const c of implCalls) {
    assert.ok(
      c.prompt.includes('.devflow-tmp'),
      `implementer prompt (label=${c.label}) に '.devflow-tmp' が含まれない。STAGING_CONVENTION が注入されていない`,
    );
    assert.ok(
      c.prompt.includes('TMPDIR'),
      `implementer prompt (label=${c.label}) に 'TMPDIR' が含まれない。STAGING_CONVENTION が注入されていない`,
    );
    assert.ok(
      c.prompt.includes('staged'),
      `implementer prompt (label=${c.label}) に 'staged' が含まれない。STAGING_CONVENTION が注入されていない`,
    );
  }
});
