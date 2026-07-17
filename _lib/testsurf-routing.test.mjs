// Issue #362: TESTSURF seeding + evaluator clearance の workflow レベル統合テスト。
//
// _lib/danger-fail-closed-loop-routing.test.mjs の VM sandbox パターン（node:vm で dev-flow.js を
// 読み込み、agent() を label/agentType で stub、journal-log prompt を捕捉して telemetry handoff
// JSON を assert）を踏襲する。
//
// このテストファイルは TDD red として作成された。F4 実装（dev-flow.js への TESTSURF seeding +
// clearance 4 点配線）完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helper（danger-fail-closed-loop-routing.test.mjs をベースに拡張）----

/**
 * testsurf 専用の VM sandbox を組む。
 * danger-grep 系（label が 'danger-grep' で始まる。Security floor / Merge tier 両方）の応答を
 * riskResponse で切り替え可能にし、evaluator 呼び出し回数・evaluator prompt・journal-log prompt を捕捉する。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} riskResponse - danger-grep / danger-grep-final stub が返すレスポンス
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス（全 iteration で同一を返す）
 * @returns {{ ctx: vm.Context, counters: object }}
 */
function makeSandbox(analyzeReq, riskResponse, evaluatorResponse) {
  const evalCalls = [];
  const evalPrompts = [];
  const journalPrompts = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return riskResponse;
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      evalCalls.push({ label, agentType });
      evalPrompts.push(prompt);
      return evaluatorResponse;
    }
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    if (agentType === 'dev-runner-haiku-ro' && label === 'realized-diff') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (agentType === 'dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (label === 'post-summary' && agentType === 'dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { logged: true, summary: 'ok' };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
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
  return {
    ctx,
    counters: {
      evaluatorCalls: () => evalCalls.length,
      evaluatorPrompts: () => evalPrompts,
      journalPrompts: () => journalPrompts,
    },
  };
}

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

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// フィクスチャ
// ============================================================

const ANALYZE_REQ_STANDARD = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

const ANALYZE_REQ_MICRO = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'docs',
  scope: 'docs',
  estimated_change_file_count: 1,
  shape: 'micro',
};

// test-weakening hit（pattern:'skip'）。SEC 7 クラスとは別系統。
const RISK_TESTSURF_HIT = {
  ok: true,
  hits: [{ file: '_lib/foo.test.mjs', class: 'test-weakening', severity: 'critical', pattern: 'skip' }],
};

const EVAL_NO_CLEARANCE = {
  verdict: 'pass',
  total: 100,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
  security_clearance: [],
  testsurf_clearance: [],
};

const EVAL_WITH_CLEARANCE = {
  verdict: 'pass',
  total: 100,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
  security_clearance: [],
  testsurf_clearance: [
    { pattern: 'skip', cleared: true, evidence: 'refactor: 同等テストを bar.test.mjs へ移設' },
  ],
};

const EVAL_MICRO_CLEARANCE = {
  verdict: 'pass',
  total: 100,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
  security_clearance: [],
  testsurf_clearance: [
    { pattern: 'skip', cleared: true, evidence: 'refactor: 同等テストを bar.test.mjs へ移設' },
  ],
};

// ============================================================
// テストケース
// ============================================================

test('[testsurf] (a) TESTSURF hit + clearance 無し → merge tier HOLD、reasons に test-weakening / TESTSURF-SKIP、telemetry に skip', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_STANDARD, RISK_TESTSURF_HIT, EVAL_NO_CLEARANCE);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.merge_tier, 'HOLD', `TESTSURF hit が未クリアなら merge tier は HOLD になるべきだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  const reasons = result?.merge_tier_reasons ?? [];
  assert.ok(reasons.some((x) => x.includes('test-weakening')), `reasons に 'test-weakening' を含むべきだが: ${JSON.stringify(reasons)}`);
  assert.ok(reasons.some((x) => x.includes('TESTSURF-SKIP')), `reasons に 'TESTSURF-SKIP' を含むべきだが: ${JSON.stringify(reasons)}`);

  assert.ok(Array.isArray(result?.testsurf_hits) && result.testsurf_hits.includes('skip'), `return object の testsurf_hits に 'skip' を含むべきだが: ${JSON.stringify(result?.testsurf_hits)}`);
  assert.ok(!(result?.danger_hits ?? []).includes('test-weakening'), `danger_hits に test-weakening が混入してはならないが: ${JSON.stringify(result?.danger_hits)}`);

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1, `journal-log は 1 回呼ばれるべきだが ${journalPrompts.length} 回だった`);
  assert.ok(journalPrompts[0].includes('"testsurf_hits"'), `journal-log prompt に '"testsurf_hits"' が含まれるべきだが含まれていなかった`);
  assert.ok(journalPrompts[0].includes('skip'), `journal-log prompt の testsurf_hits に 'skip' が含まれるべきだが含まれていなかった`);
});

test('[testsurf] (b) TESTSURF hit + evaluator clearance あり → item checked で HOLD にならない（他条件 clean 前提）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(ANALYZE_REQ_STANDARD, RISK_TESTSURF_HIT, EVAL_WITH_CLEARANCE);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.notEqual(result?.merge_tier, 'HOLD', `evaluator が evidence 付きで clearance すれば HOLD にならないべきだが '${result?.merge_tier}'（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  const reasons = result?.merge_tier_reasons ?? [];
  assert.ok(!reasons.some((x) => x.includes('test-weakening')), `clearance 済みなら reasons に test-weakening 文言を含まないべきだが: ${JSON.stringify(reasons)}`);
});

test('[testsurf] (c) micro shape + testsurf hit → Evaluate が強制実行される（evaluator 呼び出し回数 >= 1）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_MICRO, RISK_TESTSURF_HIT, EVAL_MICRO_CLEARANCE);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.ok(counters.evaluatorCalls() >= 1, `micro shape でも testsurf hit があれば Evaluate が強制実行されるべきだが evaluator は ${counters.evaluatorCalls()} 回しか呼ばれなかった`);
});

test('[testsurf] (d) TESTSURF hit があっても danger_hits（SEC 系）には混入しない（telemetry/return 両方）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_STANDARD, RISK_TESTSURF_HIT, EVAL_NO_CLEARANCE);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.ok(Array.isArray(result?.danger_hits) && result.danger_hits.length === 0, `danger_hits は空であるべきだが: ${JSON.stringify(result?.danger_hits)}`);
  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1);
  assert.ok(journalPrompts[0].includes('"danger_hits":[]'), `journal-log prompt の danger_hits は空配列であるべきだが: ${journalPrompts[0]}`);
});

test('[testsurf] (e) evaluator prompt に testsurf_focus と testsurf_clearance 契約行が含まれる（AC-3 prompt 注入検証）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_STANDARD, RISK_TESTSURF_HIT, EVAL_NO_CLEARANCE);
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const prompts = counters.evaluatorPrompts();
  assert.ok(prompts.length >= 1, 'evaluator は最低 1 回は呼ばれるべき');
  assert.ok(prompts[0].includes('testsurf_focus'), `evaluator prompt に 'testsurf_focus' が含まれるべきだが含まれていなかった`);
  assert.ok(
    prompts[0].includes('testsurf_clearance 契約:'),
    `evaluator prompt に 'testsurf_clearance 契約:' が含まれるべきだが含まれていなかった`,
  );
  assert.ok(
    prompts[0].includes('cleared:false の TESTSURF item は blocking のまま merge tier HOLD に反映される。'),
    `evaluator prompt に testsurf_clearance 契約の全文が verbatim 注入されているべきだが含まれていなかった`,
  );
});
