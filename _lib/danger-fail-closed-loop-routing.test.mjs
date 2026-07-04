// Issue #271: danger-grep fail-closed 時に Evaluate ループが EVAL_MAX まで空回りせず
// break すること・merge tier が HOLD になること・fail-closed が telemetry/return で
// danger_hits とは別軸で判別できることを検証する workflow レベル統合テスト。
//
// _lib/merge-tier-unsatisfied-ac.test.mjs / _lib/eval-convergence.test.mjs の VM sandbox
// パターン（node:vm で dev-flow.js を読み込み、agent() を label/agentType で stub、
// evaluator 呼び出し回数を counter で記録）を踏襲する。
//
// このテストファイルは TDD red として作成された。
// F3 実装（fail-closed SEC seed をループ収束からのみ除外する isLoopConvergedUnderPolicy の新設 +
// classifyMergeTier への dangerFailClosed 引数追加 + telemetry/return への danger_fail_closed 露出）
// 完了後に green になる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（merge-tier-unsatisfied-ac.test.mjs / eval-convergence.test.mjs をベースに拡張）----

/**
 * danger-fail-closed 専用の VM sandbox を組む。
 * danger-grep 系（label が 'danger-grep' で始まる。'danger-grep' と 'danger-grep-final' の両方にマッチ）
 * の応答を引数 dangerGrepResponse で切り替え可能にし、evaluator 呼び出し回数と
 * journal-log に渡された prompt を捕捉する。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} dangerGrepResponse - danger-grep / danger-grep-final stub が返すレスポンス
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス（全 iteration で同一を返す）
 * @returns {{ ctx: vm.Context, counters: { evaluatorCalls: () => number, journalPrompts: () => string[] } }}
 */
function makeSandbox(analyzeReq, dangerGrepResponse, evaluatorResponse) {
  const evalCalls = [];
  const journalPrompts = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Setup(worktree)
    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
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
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる。
    // 'danger-grep' と 'danger-grep-final' の両方をこの分岐でカバーする）
    // → 引数 dangerGrepResponse をそのまま返す（fail-closed / clean を切り替え可能）
    if (label.startsWith('danger-grep')) {
      return dangerGrepResponse;
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub が呼び出し回数を記録し、evaluatorResponse を返す
    if (agentType === 'evaluator') {
      evalCalls.push({ label, agentType });
      return evaluatorResponse;
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    // realized-diff（Security floor）: dev-runner-haiku, label='realized-diff', CHANGED schema
    if (agentType === 'dev-runner-haiku' && label === 'realized-diff') {
      return { files: ['src/foo.ts'] };
    }
    // declared-path-check（旧経路。現行は realized-diff に統合済みだが念のため残す）
    if (agentType === 'dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['src/foo.ts'] };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外。HOLD 要因を danger のみに絞る）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary: posted:true 固定
    if (label === 'post-summary' && agentType === 'dev-runner') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-log: prompt を捕捉し logged:true を返す
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { logged: true, summary: 'ok' };
    }
    // implementer その他
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // デフォルト
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: '1',
    // JS 組み込み（merge-tier-unsatisfied-ac.test.mjs / eval-convergence.test.mjs と同一セット）
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
  return {
    ctx,
    counters: {
      evaluatorCalls: () => evalCalls.length,
      journalPrompts: () => journalPrompts,
    },
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * merge-tier-unsatisfied-ac.test.mjs の runDevFlowCapture と同型。
 * IIFE の **resolved 値（return object）を捕捉して返す**。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ result: object|null, error: Error|null }>}
 */
async function runDevFlowCapture(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

// ============================================================
// テストケース
// ============================================================

// complex に落ちる req（count=7 → floor=complex → EVAL_PASSES=EVAL_MAX=10 のループ経路）。
// acceptance_criteria は 1-2 件に絞る（AC 未達要因を混入させないため）。
const ANALYZE_REQ_COMPLEX = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 7,
  shape: 'complex',
};

// danger-grep fail-closed stub（risk.ok !== true）。evidence 文字列は evidence 判別用。
const DANGER_FAIL_CLOSED = { ok: false, error: 'stub fail-closed' };

// danger-grep clean stub（正常系の回帰対照用）。
const DANGER_CLEAN = { ok: true, hits: [] };

// evaluator stub: verdict='pass'・AC 全 satisfied:true・feedback:[]・critical なし・security_clearance:[]。
// danger-grep が fail-closed(dangerHits=[]) の場合、security_focus が prompt に載らないため
// evaluator は security_clearance を返す機会がない（issue #271 のバグの核心）。
const EVAL_RESPONSE_CLEAN = {
  verdict: 'pass',
  total: 100,
  threshold: 80,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [],
};

test('[danger-fail-closed] AC#1: danger-grep fail-closed でも evaluator はちょうど 1 回で収束する（EVAL_MAX=10 まで空回りしない）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    counters.evaluatorCalls(),
    1,
    `danger-grep fail-closed 時、fail-closed な SEC seed item はループ収束判定から除外され evaluator は 1 回で収束すべきだが ${counters.evaluatorCalls()} 回呼ばれた（EVAL_MAX まで空回りしている疑い）`,
  );
});

test('[danger-fail-closed] AC#2: danger-grep fail-closed 時、merge tier は HOLD になる（軸A invariant: security floor は緩めない）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    result?.merge_tier,
    'HOLD',
    `danger-grep fail-closed（Merge tier phase の danger-grep-final も fail-closed）の場合、`
    + `merge tier 算出は fail-closed SEC seed を unchecked のまま含めて HOLD を強制すべきだが '${result?.merge_tier}' だった`,
  );
});

test('[danger-fail-closed] AC#4: return object と telemetry で danger_fail_closed（真偽値）と danger_hits（実 hit クラス）が別軸で判別できる', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // return object: danger_fail_closed:true と danger_hits:[] が両方成立する（別軸）
  assert.equal(
    result?.danger_fail_closed,
    true,
    `danger-grep fail-closed の場合、return object の danger_fail_closed は true であるべきだが ${JSON.stringify(result?.danger_fail_closed)} だった`,
  );
  assert.ok(
    Array.isArray(result?.danger_hits) && result.danger_hits.length === 0,
    `fail-closed 時は実 hit を検出していないため danger_hits は空配列であるべきだが ${JSON.stringify(result?.danger_hits)} だった`,
  );

  // journal-log の telemetry handoff prompt に "danger_fail_closed" が含まれる
  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1, `journal-log は 1 回呼ばれるべきだが ${journalPrompts.length} 回だった`);
  assert.ok(
    journalPrompts[0].includes('"danger_fail_closed"'),
    `journal-log prompt（telemetry handoff）に '"danger_fail_closed"' が含まれるべきだが含まれていなかった。prompt:\n${journalPrompts[0]}`,
  );
});

test('[danger-fail-closed] AC#5 regression: danger-grep clean 時は evaluator 1 回で収束し、merge tier は danger 起因で HOLD にならず danger_fail_closed:false になる', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_CLEAN, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    counters.evaluatorCalls(),
    1,
    `danger-grep clean（正常系）では回帰なく evaluator は 1 回で収束すべきだが ${counters.evaluatorCalls()} 回呼ばれた`,
  );

  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `danger-grep clean + AC 全 satisfied + critical なしの場合、merge tier は danger 起因で HOLD になるべきでないが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`,
  );

  assert.equal(
    result?.danger_fail_closed,
    false,
    `danger-grep clean の場合、danger_fail_closed は false であるべきだが ${JSON.stringify(result?.danger_fail_closed)} だった`,
  );
});
