// re-floor の振る舞いを VM sandbox で pin するテスト。
// _lib/shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox を踏襲する。
//
// 主な相違点:
//   (a) agent() stub に label==='realized-diff' 分岐を追加し、テストごとに可変な realized ファイル数を返す。
//       'declared-path-check' label は別分岐で {files:[]} を返し衝突を排除する（label レベル分離）。
//   (b) runDevFlowInSandbox は vm.runInContext の戻り値（workflow の return object）を解決して
//       呼び出し元へ返すよう拡張する（return object 検証のため）。
//
// テストケース:
//   (A) [refloor] micro 見積もり + realized 6 件 → evaluator >= 1 回 + shape_refloored===true + effective_shape==='complex'
//   (B) [refloor] standard 見積もり + realized 6 件 → evaluator >= 2 回（EVAL_PASSES=EVAL_MAX 化で full ループ）
//   (C) [refloor] micro 見積もり + realized 1 件 → evaluator 0 回 + shape_refloored===false
//
// TDD red: F2/F3 実装前は realized-diff call 不在・EFFECTIVE_SHAPE 不在で評価カウントと
//          return フィールドが期待と乖離し赤になる。F2/F3 実装後に全緑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox と同型）----

/**
 * refloor-shape-routing 専用の VM sandbox を組む。
 * makeCountingSandbox と同型: agent() を呼び出しカウンタ stub にし、calls 配列を expose する。
 * 相違点(a): realized-diff label 分岐で可変ファイル数を返す / declared-path-check label 分岐で {files:[]} を返す。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {string[]} realizedFiles - realized-diff stub が返すファイル一覧
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string}> }}
 */
function makeCountingSandbox(analyzeReq, realizedFiles) {
  const calls = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });

    // Setup(worktree)
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan: dev-planner (plan#trivial / plan#standard / plan#N / replan 系)
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    if (label.startsWith('danger-grep')) {
      return { hits: [] };
    }
    // (a) realized-diff: label レベルで分離。可変ファイル数を返す
    if (label === 'realized-diff') {
      return { files: realizedFiles };
    }
    // (a) declared-path-check: label レベルで分離。{files:[]} を返し衝突を排除する
    if (label === 'declared-path-check') {
      return { files: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator
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
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // implementer その他
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // デフォルト
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'LGTM' }),
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（makeWorkflowSandbox と同一セット）
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
 * 相違点(b): vm.runInContext の戻り値（workflow の return object）を解決して呼び出し元へ返す。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ error: Error|null, returned: object|null }>}
 *   error: クラッシュがあれば Error、無ければ null
 *   returned: workflow の return object（正常完了時）、エラー時は null
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

// ============================================================
// (A) [refloor] micro 見積もり + realized 6 件 → evaluator >= 1 回（runEval 強制点火）
//     かつ returned.shape_refloored===true / returned.effective_shape==='complex'
// ============================================================

test('[refloor] (A) micro 見積もり + realized 6 files → evaluator >= 1 回 + shape_refloored + effective_shape=complex', async () => {
  // micro に落ちる req（count=1 ≤ 2, ac.length=2 ≤ 3, type=feat → floor='micro'）
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
  };

  const src = readFileSync(devFlowPath, 'utf8');
  // realized-diff stub は 6 ファイルを返す → refloorShape('micro', 6) → complex → runEval=true
  const { ctx, calls } = makeCountingSandbox(microReq, ['a', 'b', 'c', 'd', 'e', 'f']);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（shape-loop-routing.test.mjs:171 と同型）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `(A) micro + realized 6 files: evaluator は >= 1 回呼ばれるべきだが ${evaluatorCalls.length} 回`
      + ` (realized-diff が 6 ファイル → re-floor → EFFECTIVE_SHAPE=complex → runEval=true)`,
  );

  // return object 検証: shape_refloored===true（micro→complex へ昇格）
  assert.ok(
    returned !== null,
    '(A) workflow は return object を返すべきだが null だった',
  );
  assert.strictEqual(
    returned?.shape_refloored,
    true,
    `(A) returned.shape_refloored は true のはずだが ${JSON.stringify(returned?.shape_refloored)} だった`,
  );

  // return object 検証: effective_shape==='complex'
  assert.strictEqual(
    returned?.effective_shape,
    'complex',
    `(A) returned.effective_shape は 'complex' のはずだが ${JSON.stringify(returned?.effective_shape)} だった`,
  );
});

// ============================================================
// (B) [refloor] standard 見積もり + realized 6 件 → EVAL_PASSES が EVAL_MAX 化
//     evaluator stub が 1 回目 fail / 2 回目 pass → evaluator >= 2 回（full ループ確認）
//     design churn 早期打ち切りに掛からないこと（feedback_level='implementation'）
// ============================================================

test('[refloor] (B) standard 見積もり + realized 6 files → evaluator >= 2 回（EVAL_PASSES=EVAL_MAX）', async () => {
  // standard に落ちる req（count=3 ≤ 5, ac.length=4 ≤ 6, type=feat → floor='standard'）
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  let evaluatorCallCount = 0;

  // evaluator stub: 呼び出し回数で verdict を出し分け（1 回目 fail / 2 回目 pass）
  // feedback_level='implementation' で design churn 早期打ち切りに掛からないことを確認
  const agentStubWithFailFirst = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return standardReq;
    if (agentType === 'dev-planner') return { summary: 'p', serial: [], parallel: [] };
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { hits: [] };
    // (a) realized-diff: 6 ファイル返す → standard+6件 → EFFECTIVE_SHAPE=complex → EVAL_PASSES=EVAL_MAX
    if (label === 'realized-diff') {
      return { files: ['a', 'b', 'c', 'd', 'e', 'f'] };
    }
    // (a) declared-path-check: {files:[]} で衝突を排除
    if (label === 'declared-path-check') {
      return { files: [] };
    }
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (agentType === 'evaluator') {
      evaluatorCallCount += 1;
      if (evaluatorCallCount === 1) {
        // 1 回目: fail → 差し戻しを発生させる（feedback_level='implementation' で design churn 打ち切り非対象）
        return {
          verdict: 'fail',
          total: 50,
          threshold: 80,
          feedback: [{ topic: 'test-issue', severity: 'major', dimension: 'implementation', body: 'fix needed' }],
          feedback_level: 'implementation',
          ac_results: [],
          security_clearance: [],
        };
      }
      // 2 回目以降: pass
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
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStubWithFailFirst,
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
  const src = readFileSync(devFlowPath, 'utf8');
  const { error } = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（shape-loop-routing.test.mjs:171 と同型）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    evaluatorCallCount >= 2,
    `(B) standard + realized 6 files: evaluator は >= 2 回呼ばれるべきだが ${evaluatorCallCount} 回`
      + ` (realized-diff 6 ファイル → re-floor → EFFECTIVE_SHAPE=complex → EVAL_PASSES=EVAL_MAX → 差し戻しループ可能)`,
  );
});

// ============================================================
// (C) [refloor] micro 見積もり + realized 1 件 → 挙動不変（evaluator 0 回・shape_refloored===false）
// ============================================================

test('[refloor] (C) micro 見積もり + realized 1 file → evaluator 0 回（re-floor なし） + shape_refloored===false', async () => {
  // micro に落ちる req（count=1 ≤ 2, ac.length=2 ≤ 3, type=feat → floor='micro'）
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
  };

  const src = readFileSync(devFlowPath, 'utf8');
  // realized-diff stub は 1 ファイルのみ → refloorShape('micro', 1) → micro（変化なし）→ runEval=false
  const { ctx, calls } = makeCountingSandbox(microReq, ['src/foo.ts']);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（shape-loop-routing.test.mjs:171 と同型）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.equal(
    evaluatorCalls.length,
    0,
    `(C) micro + realized 1 file: evaluator は 0 回のはずだが ${evaluatorCalls.length} 回呼ばれた`
      + ` (realized 1 file → re-floor なし → EFFECTIVE_SHAPE=micro → runEval=false)`,
  );

  // return object 検証: shape_refloored===false（昇格なし）
  assert.ok(
    returned !== null,
    '(C) workflow は return object を返すべきだが null だった',
  );
  assert.strictEqual(
    returned?.shape_refloored,
    false,
    `(C) returned.shape_refloored は false のはずだが ${JSON.stringify(returned?.shape_refloored)} だった`,
  );
});

// ============================================================
// 構造テスト: refloorShape が dev-flow.js に存在する
// ============================================================
test('[refloor][struct] dev-flow.js に refloorShape 関数定義が存在する', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes('function refloorShape('),
    'dev-flow.js に `function refloorShape(` が存在すること',
  );
});

test('[refloor][struct] dev-flow.js に EFFECTIVE_SHAPE 定数定義が存在する', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes('const EFFECTIVE_SHAPE ='),
    'dev-flow.js に `const EFFECTIVE_SHAPE =` が存在すること',
  );
});

test('[refloor][struct] dev-flow.js に realized-diff label が存在する', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes("label: 'realized-diff'"),
    "dev-flow.js に `label: 'realized-diff'` が存在すること",
  );
});

test('[refloor][struct] runEval が EFFECTIVE_SHAPE 基準になっている', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes("EFFECTIVE_SHAPE !== 'micro'"),
    "dev-flow.js の runEval が `EFFECTIVE_SHAPE !== 'micro'` 基準であること",
  );
});
