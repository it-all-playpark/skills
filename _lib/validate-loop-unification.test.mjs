// TDD red として作成。F2（runValidateLoop 抽出）までテスト 2・3 は fail する。
//
// このファイルは Validate ループ統合（構造重複排除・プロンプト byte 一致・concerns 伝搬・
// テスト弱体化監査注入・GREEN_MAX ループ）を VM sandbox で pin するテストである。
// empty-diff-evaluate-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox と同型で実装する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

/**
 * validate loop unification 専用の VM sandbox を組む。
 *
 * opts.gateEmpty: true → diff-gate が empty:true を返し retry 経路を発火させる
 * opts.retryEmpty: boolean → diff-gate-retry が empty:{retryEmpty} を返す（default false）
 *
 * test stub の挙動:
 *   opts.retryAlwaysFailed: false（default）
 *     - label が 'test#retry' で始まるか否かで本経路/retry 経路を独立カウント
 *     - 各 prefix の 1 回目だけ failed を返し 2 回目以降は passed を返す
 *     - summary は両方 'SAME_FAILURE_SUMMARY' で一致させる（テスト 3 の byte 一致用）
 *   opts.retryAlwaysFailed: true
 *     - 'test#retry' で始まるラベルは常に failed を返す（GREEN_MAX ループ pin 用）
 *     - 本経路 test は 1 回目 failed、2 回目 passed（本経路は通常終了）
 *
 * green-fix stub（agentType==='implementer' && label.startsWith('green-fix')）:
 *   - 常に { status:'DONE', task_id:'t', files:['src/foo.test.ts'], summary:'typo修正', concerns:['GF_CONCERN_MARKER'] }
 *   - 本経路・retry 経路とも同一（テスト 4・5 の GF_CONCERN_MARKER 到達 pin 用）
 *
 * diff-gate は opts.gateEmpty:true / diff-gate-retry は opts.retryEmpty:false（default）で
 * retry 経路を発火させる。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.gateEmpty=false]
 * @param {boolean} [opts.retryEmpty=false]
 * @param {boolean} [opts.retryAlwaysFailed=false]
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox(opts) {
  const {
    gateEmpty = false,
    retryEmpty = false,
    retryAlwaysFailed = false,
  } = opts || {};

  const calls = [];

  // 本経路（test#N）と retry 経路（test#retry-N）のカウンタを独立管理
  let mainTestCallCount = 0;
  let retryTestCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    // Setup
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };

    // Analyze（shape:'standard', acceptance_criteria 4 件, estimated_change_file_count:3）
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['ac1', 'ac2', 'ac3', 'ac4'],
        issue_type: 'fix',
        scope: 'src',
        estimated_change_file_count: 3,
        shape: 'standard',
      };
    }

    // Plan
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 'T1', desc: 't', file_changes: [], test_plan: '' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }

    // Security / danger-grep
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };

    // diff-gate / diff-gate-retry
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };

    // diff-hash 系（eval / pr）
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };

    // Validate: test runner（label が 'test' で始まる）
    // 本経路（test#N）と retry 経路（test#retry-N）を prefix で分岐
    if (label.startsWith('test')) {
      const isRetryPath = label.startsWith('test#retry');
      if (isRetryPath) {
        retryTestCallCount += 1;
        if (retryAlwaysFailed) {
          // GREEN_MAX ループ pin 用: 常に failed を返す
          return { tests: 'failed', green: false, summary: 'SAME_FAILURE_SUMMARY' };
        }
        // 通常モード: 1 回目 failed、2 回目以降 passed
        if (retryTestCallCount === 1) {
          return { tests: 'failed', green: false, summary: 'SAME_FAILURE_SUMMARY' };
        }
        return { tests: 'passed', green: true, summary: '' };
      } else {
        mainTestCallCount += 1;
        // 本経路: 1 回目 failed、2 回目以降 passed
        if (mainTestCallCount === 1) {
          return { tests: 'failed', green: false, summary: 'SAME_FAILURE_SUMMARY' };
        }
        return { tests: 'passed', green: true, summary: '' };
      }
    }

    // Validate: green-fix（implementer + green-fix label prefix）
    // GF_CONCERN_MARKER を concerns に含め、テスト 4・5 の pin を支える
    if (agentType === 'implementer' && label.startsWith('green-fix')) {
      return {
        status: 'DONE',
        task_id: 't',
        files: ['src/foo.test.ts'],
        summary: 'typo修正',
        concerns: ['GF_CONCERN_MARKER'],
      };
    }

    // implementer（通常）
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }

    // Evaluate
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

    // realized-diff / declared-path-check / changed-files
    if (label === 'realized-diff') return { files: ['src/foo.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };

    // PR 系
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };

    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'LGTM' }),
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
 * empty-diff-evaluate-routing.test.mjs の runDevFlowInSandbox と同型。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ error: Error|null, returned: object|null }>}
 */
async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;
  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

// ============================================================
// (1) crash guard — ReferenceError/SyntaxError で fail
// ============================================================

test('[validate-unify] (1) crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeCountingSandbox({ gateEmpty: false });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
});

// ============================================================
// (2) 構造 pin — function runValidateLoop 出現回数 >= 1、
//     テストスイートを実行し == 1（ちょうど 1）、禁止文 == 1（ちょうど 1）
// NOTE: F2（runValidateLoop 抽出）前は RED（runValidateLoop 0 件、テストスイートを実行し 2 件）
// ============================================================

test('[validate-unify] (2) 構造 pin: function runValidateLoop が 1 箇所以上・テストスイートを実行し がちょうど 1・禁止文がちょうど 1', () => {
  const src = readFileSync(devFlowPath, 'utf8');

  const runValidateLoopCount = (src.match(/function runValidateLoop/g) || []).length;
  assert.ok(
    runValidateLoopCount >= 1,
    `dev-flow.js に 'function runValidateLoop' が ${runValidateLoopCount} 箇所（>= 1 が必要）。`
    + 'F2（runValidateLoop 抽出）が完了していない。',
  );

  const testSuiteCount = (src.match(/テストスイートを実行し/g) || []).length;
  assert.strictEqual(
    testSuiteCount,
    1,
    `dev-flow.js の 'テストスイートを実行し' がちょうど 1 箇所であるべきだが ${testSuiteCount} 箇所。`
    + 'runValidateLoop に統合されると 1 箇所になる（現状は本経路・retry 経路で 2 箇所）。',
  );

  const forbiddenCount = (src.match(/テストの期待値・assert を弱めて green にすることは禁止/g) || []).length;
  assert.strictEqual(
    forbiddenCount,
    1,
    `dev-flow.js の禁止文 'テストの期待値・assert を弱めて green にすることは禁止' がちょうど 1 箇所であるべきだが ${forbiddenCount} 箇所。`,
  );
});

// ============================================================
// (3) プロンプト同一 pin（gateEmpty:true で retry 経路を発火）
//   - test#1 prompt === test#retry-1 prompt（byte 一致）
//   - green-fix#1 prompt === green-fix#retry-1 prompt（byte 一致）
// NOTE: F2（runValidateLoop 抽出）前は RED（retry 側の空白 drift で green-fix prompt 不一致）
// ============================================================

test('[validate-unify] (3) プロンプト同一 pin: test#1 と test#retry-1 のプロンプト byte 一致・green-fix#1 と green-fix#retry-1 のプロンプト byte 一致', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true, retryEmpty: false });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // test runner プロンプト: test#1 と test#retry-1
  const testMain1 = calls.find((c) => c.label === 'test#1');
  const testRetry1 = calls.find((c) => c.label === 'test#retry-1');

  assert.ok(testMain1 != null, `label === 'test#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(testRetry1 != null, `label === 'test#retry-1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);

  assert.strictEqual(
    testMain1.prompt,
    testRetry1.prompt,
    `test#1 と test#retry-1 のプロンプトが byte 一致しない（空白 drift 等）。`
    + `\ntest#1 prompt（先頭200字）: ${testMain1.prompt.slice(0, 200)}`
    + `\ntest#retry-1 prompt（先頭200字）: ${testRetry1.prompt.slice(0, 200)}`,
  );

  // green-fix プロンプト: green-fix#1 と green-fix#retry-1
  const gfMain1 = calls.find((c) => c.label === 'green-fix#1');
  const gfRetry1 = calls.find((c) => c.label === 'green-fix#retry-1');

  assert.ok(gfMain1 != null, `label === 'green-fix#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(gfRetry1 != null, `label === 'green-fix#retry-1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);

  assert.strictEqual(
    gfMain1.prompt,
    gfRetry1.prompt,
    `green-fix#1 と green-fix#retry-1 のプロンプトが byte 一致しない（空白 drift 等）。`
    + `\ngreen-fix#1 prompt（先頭300字）: ${gfMain1.prompt.slice(0, 300)}`
    + `\ngreen-fix#retry-1 prompt（先頭300字）: ${gfRetry1.prompt.slice(0, 300)}`,
  );
});

// ============================================================
// (4) concerns 伝搬同一 pin（gateEmpty:true で両経路発火）
//   - eval#1 の prompt に 'GF_CONCERN_MARKER' が含まれること
//   - 本経路 + retry 経路の green-fix concerns が evaluator focus_areas へ到達
// ============================================================

test('[validate-unify] (4) concerns 伝搬同一 pin: eval#1 の prompt に GF_CONCERN_MARKER が含まれること（本経路+retry 経路 green-fix concerns → evaluator）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true, retryEmpty: false });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('GF_CONCERN_MARKER'),
    `eval#1 の prompt に 'GF_CONCERN_MARKER' が含まれていない。`
    + `\nprompt（先頭600字）:\n${eval1.prompt.slice(0, 600)}`,
  );
});

// ============================================================
// (5) テスト弱体化監査注入 pin（gateEmpty:true で両経路発火）
//   - eval#1 の prompt に 'テスト弱体化' が含まれること
//   - eval#1 の prompt に 'src/foo.test.ts' が含まれること
//   - eval#1 の prompt に '申告された根拠' が含まれること
//   （pushGreenFixAudit が両経路分を注入）
// ============================================================

test('[validate-unify] (5) テスト弱体化監査注入 pin: eval#1 の prompt に テスト弱体化・src/foo.test.ts・申告された根拠 が含まれること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true, retryEmpty: false });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('テスト弱体化'),
    `eval#1 の prompt に 'テスト弱体化' が含まれていない。\nprompt（先頭600字）:\n${eval1.prompt.slice(0, 600)}`,
  );
  assert.ok(
    eval1.prompt.includes('src/foo.test.ts'),
    `eval#1 の prompt に 'src/foo.test.ts' が含まれていない。\nprompt（先頭600字）:\n${eval1.prompt.slice(0, 600)}`,
  );
  assert.ok(
    eval1.prompt.includes('申告された根拠'),
    `eval#1 の prompt に '申告された根拠' が含まれていない。\nprompt（先頭600字）:\n${eval1.prompt.slice(0, 600)}`,
  );
});

// ============================================================
// (6) GREEN_MAX ループ pin（retry prefix 常時 failed モード、gateEmpty:true）
//   - label が 'test#retry' で始まる call がちょうど 3 件（GREEN_MAX=3）
//   - label が 'green-fix#retry' で始まる call がちょうど 2 件（GREEN_MAX-1）
// ============================================================

test('[validate-unify] (6) GREEN_MAX ループ pin: test#retry ちょうど 3 件・green-fix#retry ちょうど 2 件（retry 常時 failed モード）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true, retryEmpty: false, retryAlwaysFailed: true });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const retryTestCalls = calls.filter((c) => c.label.startsWith('test#retry'));
  assert.strictEqual(
    retryTestCalls.length,
    3,
    `label が 'test#retry' で始まる call がちょうど 3 件（GREEN_MAX=3）であるべきだが ${retryTestCalls.length} 件。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );

  const retryGfCalls = calls.filter((c) => c.label.startsWith('green-fix#retry'));
  assert.strictEqual(
    retryGfCalls.length,
    2,
    `label が 'green-fix#retry' で始まる call がちょうど 2 件（GREEN_MAX-1=2）であるべきだが ${retryGfCalls.length} 件。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );
});
