// re-floor の振る舞いを VM sandbox で pin するテスト。
// _lib/shape-loop-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox を踏襲する。
//
// 主な相違点:
//   (a) agent() stub に label==='realized-diff' 分岐を追加し、テストごとに可変な realized ファイル数を返す。
//       'declared-path-check' label は別分岐で {files:[]} を返し衝突を排除する（label レベル分離）。
//   (b) runDevFlowInSandbox は vm.runInContext の戻り値（workflow の return object）を解決して
//       呼び出し元へ返すよう拡張する（return object 検証のため）。
//
// issue #272 F2 実装後の新挙動: refloor の realized count は「non-ephemeral のうち plan の
// file_changes に宣言済みのファイル数」（= filterEphemeralPaths 後の一覧から diffDeclaredPaths の
// 宣言外を引いた数）で算出する。宣言外 non-ephemeral 変更が 1 件以上あると micro でも
// runEval=true（Evaluate 強制）になる。そのため makeCountingSandbox は dev-planner stub の
// file_changes に realized ファイルを宣言させる declaredFiles 引数を持つ（省略時は realizedFiles を
// 全件宣言 = 従来どおり宣言外なしの挙動）。
//
// テストケース:
//   (A) [refloor] micro 見積もり + realized 6 件（全件宣言）→ evaluator >= 1 回 + shape_refloored===true + effective_shape==='complex'
//   (B) [refloor] standard 見積もり + realized 6 件（全件宣言）→ evaluator >= 2 回（EVAL_PASSES=EVAL_MAX 化で full ループ）
//   (C) [refloor] micro 見積もり + realized 1 件（宣言済み）→ evaluator 0 回 + shape_refloored===false
//   (F) [refloor] micro 見積もり + realized 6 件が全て宣言外（plan file_changes: []）→ declared count=0 で
//       refloor 不発（shape_refloored===false・effective_shape===micro）だが宣言外監査で evaluator >= 1 回
//   (G) [refloor] micro 見積もり + realized 3 件のうち宣言済み2件・宣言外1件 → declared count=2 で
//       refloor 不発（shape_refloored===false）だが宣言外監査で evaluator >= 1 回
//
// TDD red: F2/F3 実装前は realized-diff call 不在・EFFECTIVE_SHAPE 不在で評価カウントと
//          return フィールドが期待と乖離し赤になる。F2/F3 実装後に全緑。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, mergeTierFacts, withImplementMode } from './test-helpers/vm-sandbox.mjs';

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
 * @param {string[]} [changedFiles=['src/foo.ts']] - changed-files stub が返すファイル一覧（merge tier 判定に使用）
 * @param {string[]} [declaredFiles=realizedFiles] - dev-planner stub が file_changes として宣言するファイル一覧
 *   （省略時は realizedFiles を全件宣言 = 宣言外なし。宣言外監査シナリオ用に部分集合/空配列を渡せる）
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox(analyzeReq, realizedFiles, changedFiles = ['src/foo.ts'], declaredFiles = realizedFiles) {
  const calls = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  // prompt も観測用に calls へ記録する（実行時に dev-flow.js が実際に組み立てた prompt を
  // VM 挙動として検証できるようにするため。静的ソース走査の代替）。
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt });

    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan: dev-planner (plan#trivial / plan#standard / plan#N / replan 系)
    // declaredFiles を file_changes として宣言する（省略時は realizedFiles 全件 = 宣言外なし）。
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', file_changes: declaredFiles }], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'dev-flow:plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor: label 'danger-grep'（issue #544 統合呼び出し）は risk/files を 1 応答で
    // 返す。files は可変ファイル数（旧 realized-diff 相当。null なら agent drop 相当）。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: realizedFiles, struct: null, diffhash: null };
    }
    // Merge tier: label 'merge-tier-facts'（統合呼び出し。changed は可変ファイル数）
    if (label === 'merge-tier-facts') {
      return mergeTierFacts({ files: changedFiles });
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator
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
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // implementer その他
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
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
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    // 引数（ISSUE 解決用）
    args: devFlowArgs('1'),
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
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // IMPLEMENT_MODE を 'planner' に固定（standard shape の従来経路 dev-planner → implementer を pin する。
  // 'fable' 経路は devflow-implement-fable-routing.test.mjs が検証する）
  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');
  // realized-diff stub は 6 ファイルを返す → refloorShape('micro', 6) → complex → runEval=true
  const { ctx, calls } = makeCountingSandbox(microReq, ['a', 'b', 'c', 'd', 'e', 'f']);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（shape-loop-routing.test.mjs:171 と同型）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
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
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  let evaluatorCallCount = 0;

  // evaluator stub: 呼び出し回数で verdict を出し分け（1 回目 fail / 2 回目 pass）
  // feedback_level='implementation' で design churn 早期打ち切りに掛からないことを確認
  const agentStubWithFailFirst = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return standardReq;
    // (B) は「全件宣言」シナリオ（realized の 6 ファイルを file_changes に宣言）。
    // 宣言外のままだと diffDeclaredPaths が全件を宣言外扱いし declared count=0 に潰れ、
    // refloor が発火しない（EFFECTIVE_SHAPE が standard のまま止まる）ため明示的に宣言する。
    if (agentType === 'dev-flow:dev-planner') return { summary: 'p', serial: [{ id: 't1', file_changes: ['a', 'b', 'c', 'd', 'e', 'f'] }], parallel: [] };
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    // (a) label 'danger-grep'（issue #544 統合呼び出し）: 6 ファイル返す
    // → standard+6件 → EFFECTIVE_SHAPE=complex → EVAL_PASSES=EVAL_MAX
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['a', 'b', 'c', 'd', 'e', 'f'], struct: null, diffhash: null };
    }
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: ['src/foo.ts'] });
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (agentType === 'dev-flow:evaluator') {
      evaluatorCallCount += 1;
      if (evaluatorCallCount === 1) {
        // 1 回目: fail → 差し戻しを発生させる（feedback_level='implementation' で design churn 打ち切り非対象）
        return {
          verdict: 'fail',
          total: 50,
          threshold: 80,
          feedback: [{ topic: 'test-issue', severity: 'critical', dimension: 'implementation', description: 'fix needed', suggestion: 'fix it' }],
          feedback_level: 'implementation',
          ac_results: [],
          security_clearance: [],
        };
      }
      // 2 回目以降: pass。critical_resolutions で EVAL-1-test-issue を解消する（issue #174 新設計）。
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-test-issue', resolved: true, evidence: 'test-issue fixed and verified in tests' }],
      };
    }
    if (agentType === 'dev-flow:implementer') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStubWithFailFirst,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: devFlowArgs('1'),
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
  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');
  const { error } = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（shape-loop-routing.test.mjs:171 と同型）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    evaluatorCallCount,
    2,
    `(B) standard + realized 6 files: evaluator は 2 回で収束すべきだが ${evaluatorCallCount} 回`
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
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');
  // realized-diff stub は 1 ファイルのみ → refloorShape('micro', 1) → micro（変化なし）→ runEval=false
  const { ctx, calls } = makeCountingSandbox(microReq, ['src/foo.ts']);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（shape-loop-routing.test.mjs:171 と同型）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
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

// refloorShape / EFFECTIVE_SHAPE / danger-grep label / runEval の基準は、上の (A)〜(C) が
// 実際に VM で dev-flow.js を実行し shape_refloored・effective_shape・evaluator 呼び出し回数を
// 挙動として検証済み（label が変われば danger-grep 分岐に到達せず calls が想定外の分岐に落ちて
// 上記アサートが落ちる）。関数名・定数名・label 文字列の存在だけを個別に pin する構造テストは
// 冗長なため削除する（issue #636）。

// ============================================================
// (D) [refloor] realized-diff agent が null を返す（drop / skip）→ NaN → complex 安全弁
//     ?? [] を使うと失敗が 0 に潰れ runEval=false になるが、正しい実装では
//     realizedCount=NaN → refloorShape('micro', NaN) → complex → runEval=true
// ============================================================

test('[refloor] (D) realized-diff が null を返す（agent drop）→ NaN 経由で complex → evaluator >= 1 回', async () => {
  // micro に落ちる req（realized-diff が null を返しても complex 安全弁で evaluator が走ること）
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const calls = [];

  // realized-diff label を意図的に null（agent drop 相当）で返す specialized stub
  const agentStubNullRealized = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });

    if (label.startsWith('analyze')) {
      return microReq;
    }
    if (agentType === 'dev-flow:dev-planner') {
      return {
        serial: [{ task_id: 't1', title: 'task', file_changes: ['src/foo.ts'], description: 'd', acceptance: ['a'] }],
        parallel: [],
        summary: 's',
      };
    }
    if (agentType === 'dev-flow:plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // (D) label 'danger-grep'（issue #544 統合呼び出し）は risk は正常のまま files を null で返す
    // （旧 realized-diff の agent drop 相当）→ ?? [] を使うと 0 に潰れ runEval=false になるバグ再現。
    // risk と files は per-field 独立のため、files 欠落が risk（fail-closed 判定）へ波及しないこと
    // も同時に確認する。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: null, struct: null, diffhash: null };
    }
    if (label === 'merge-tier-facts') {
      return mergeTierFacts({ files: ['src/foo.ts'] });
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
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStubNullRealized,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: devFlowArgs('1', { worktree: '/tmp/test-wt' }),
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
  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `(D) realized-diff=null: evaluator は >= 1 回呼ばれるべきだが ${evaluatorCalls.length} 回`
      + ' (null → NaN → refloorShape → complex → runEval=true)',
  );
});

// [refloor][struct] の "?? [] で 0 に潰していない" 静的 pin は削除する（issue #636）。
// null→NaN の安全弁は上の (D) が VM 実行で挙動として検証済み（realized-diff が null を
// 返すケースで evaluator >= 1 回が観測できる。`?? []` に潰れていれば evaluator 0 回で落ちる）。
// また issue #544 の secfloor-classify.sh 統合後、dev-flow.js 側には
// `realized?.files ? realized.files.length : NaN` という厳密一致の式はもはや存在せず
// （実コードは `realized?.files ? filterEphemeralPaths(realized.files) : null` — issue #272 F2）、
// このテストが green だったのは同一文字列がコメント（旧パターンの引用）に残っていたことに
// 依存した false green だった。

// [refloor][struct] "git status --porcelain を使う（三点 diff を使わない）" も削除する（issue #636）。
// この検証対象の git コマンドは issue #544 の統合で `_shared/scripts/secfloor-classify.sh`
// （dev-flow.js から見て外部スクリプト）内に移動済みで、dev-flow.js 側の該当箇所は
// 「secfloor-classify.sh は git status --porcelain --untracked-files=all を直接パースする」という
// コメント（実行されないプロース）のみが残る。実際の git コマンド選択（status --porcelain
// であり三点 diff でないこと）は `_shared/scripts/secfloor-classify.bats` の
// 「変更ファイルあり -> files に該当パスが載る（通常変更 + リネーム右側）」が実 git 実行で
// 検証済み（コミット済み BASE_REF に対し未コミットの rename を検出できることを assert しており、
// 三点 diff ではこの未コミット差分は観測できない）。dev-flow.js 側のコメント文字列を pin しても
// 実行される git コマンドの正しさは保証できないため削除する。

// ============================================================
// [merge-tier] (D) micro 見積もり + realized 4 docs/test-only files + changed-files docs/test-only
//              → merge_tier==='REVIEW'（refloor 昇格後は AUTO 推奨ラベル禁止）
//
// Bug: classifyMergeTier に SHAPE(='micro') を渡すと isDocsOrTestOnly=true のとき
//      AUTO を返してしまう。正しくは EFFECTIVE_SHAPE(='standard') を渡すべき。
// Fix: dev-flow.js L1945 の `shape: SHAPE,` を `shape: EFFECTIVE_SHAPE,` に変更する。
// ============================================================
test('[merge-tier] (D) micro 見積もり + realized 4 docs/test-only + changed-files docs-only → merge_tier===REVIEW（AUTO 禁止）', async () => {
  // micro に落ちる req（count=1 ≤ 2, ac.length=2 ≤ 3, type=fix → floor='micro'）
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');

  // realized-diff: 4 件（.md / docs/ / *test* にマッチ → isDocsOrTestOnly=true）
  // ephemeral filter（.devflow-tmp / .staged. / fm_*.txt）には掛からないパス
  const docsTestFiles = ['docs/a.md', 'docs/b.md', 'README.md', '_lib/foo.test.mjs'];

  // changed-files も同じ docs/test-only ファイル → isDocsOrTestOnly=true
  // refloorShape('micro', 4): 4 ファイル → realizedFloor='standard' > micro → EFFECTIVE_SHAPE='standard'
  // classifyMergeTier に EFFECTIVE_SHAPE='standard' を渡すと shape!='micro' → tier='REVIEW'（AUTO にならない）
  const { ctx, calls } = makeCountingSandbox(microReq, docsTestFiles, docsTestFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(returned !== null, '(D) workflow は return object を返すべきだが null だった');

  assert.strictEqual(
    returned?.shape_refloored,
    true,
    `(D) returned.shape_refloored は true のはずだが ${JSON.stringify(returned?.shape_refloored)} だった`
      + ' (4 docs/test-only files → refloorShape("micro", 4) → standard → refloored=true)',
  );

  assert.strictEqual(
    returned?.effective_shape,
    'standard',
    `(D) returned.effective_shape は 'standard' のはずだが ${JSON.stringify(returned?.effective_shape)} だった`
      + ' (micro + 4 files → refloor → standard)',
  );

  assert.strictEqual(
    returned?.merge_tier,
    'REVIEW',
    `(D) returned.merge_tier は 'REVIEW' のはずだが ${JSON.stringify(returned?.merge_tier)} だった`
      + ' — refloor 昇格後は AUTO 推奨ラベル禁止 — classifyMergeTier に EFFECTIVE_SHAPE を渡す'
      + ' (現状 shape: SHAPE を渡しているため merge_tier=AUTO になるバグ)',
  );
});

// ============================================================
// [merge-tier] (E) micro 見積もり + realized 1 docs file + changed-files docs-only
//              → merge_tier==='AUTO'（genuine micro の AUTO 経路を regress させない）
//
// Control: refloor が発火しない（1 file → micro 維持）かつ docs-only → AUTO のまま。
// ============================================================
test('[merge-tier] (E) micro 見積もり + realized 1 docs file + changed-files docs-only → merge_tier===AUTO（genuine micro regress なし）', async () => {
  // micro に落ちる req（count=1 ≤ 2, ac.length=2 ≤ 3, type=fix → floor='micro'）
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const src = withImplementMode(readFileSync(devFlowPath, 'utf8'), 'planner');

  // realized-diff: 1 件（.md → isDocsOrTestOnly=true）
  // refloorShape('micro', 1): 1 ファイル → realizedFloor='micro' → EFFECTIVE_SHAPE='micro'（昇格なし）
  const docsFile = ['docs/a.md'];

  // changed-files も docs-only → isDocsOrTestOnly=true
  // classifyMergeTier に EFFECTIVE_SHAPE='micro' + docsOrTestOnly=true → tier='AUTO'（正常経路）
  const { ctx } = makeCountingSandbox(microReq, docsFile, docsFile);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(returned !== null, '(E) workflow は return object を返すべきだが null だった');

  assert.strictEqual(
    returned?.shape_refloored,
    false,
    `(E) returned.shape_refloored は false のはずだが ${JSON.stringify(returned?.shape_refloored)} だった`
      + ' (1 file → refloor 発火せず micro 維持 → refloored=false)',
  );

  assert.strictEqual(
    returned?.effective_shape,
    'micro',
    `(E) returned.effective_shape は 'micro' のはずだが ${JSON.stringify(returned?.effective_shape)} だった`
      + ' (1 docs file → refloor なし → micro 維持)',
  );

  assert.strictEqual(
    returned?.merge_tier,
    'AUTO',
    `(E) returned.merge_tier は 'AUTO' のはずだが ${JSON.stringify(returned?.merge_tier)} だった`
      + ' — genuine micro + docs-only の AUTO 経路を regress させない'
      + ' (EFFECTIVE_SHAPE=micro + docsOrTestOnly=true → AUTO が正常)',
  );
});
