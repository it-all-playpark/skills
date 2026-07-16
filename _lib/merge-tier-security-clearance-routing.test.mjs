// Issue #299: Evaluate 時点で danger-grep clean だった PR が、pr-iterate 後の Merge tier
// phase の最終 danger-grep 再実行で新規に danger class を hit した場合、one-shot security
// clearance が呼ばれ、cleared:true + 非空 evidence のみ該当 SEC ledger item を checked にして
// HOLD を回避することを検証する workflow レベル統合テスト（PR #16 相当の再現）。
//
// _lib/danger-fail-closed-loop-routing.test.mjs の VM sandbox パターン（node:vm で
// .claude/workflows/dev-flow.js を読み込み、agent() を label/agentType で stub）を踏襲する。
// 本テストは Security floor（Evaluate 前, label:'danger-grep'）と Merge tier（label:
// 'danger-grep-final'）に**別々**の danger-grep レスポンスを注入できるようにし、
// 'security-clearance-final' の呼び出し回数・prompt、'journal-log'/'post-summary' の
// prompt（merge_tier / summary body）を捕捉する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

/**
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} dangerGrepPre - Security floor（Evaluate 前, label:'danger-grep'）の stub レスポンス
 * @param {object} dangerGrepFinal - Merge tier（label:'danger-grep-final'）の stub レスポンス
 * @param {object} evaluatorResponse - Evaluate 本体（label:'eval#N'）の stub レスポンス（全 iteration 同一）
 * @param {object|null} clearanceResponse - 'security-clearance-final' の stub レスポンス（null 可）
 */
function makeSandbox(analyzeReq, dangerGrepPre, dangerGrepFinal, evaluatorResponse, clearanceResponse) {
  const evalCalls = [];
  const clearanceCalls = [];
  const journalPrompts = [];
  const summaryPrompts = [];

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
    // Security floor（Evaluate 前）の danger-grep
    if (label === 'danger-grep') {
      return dangerGrepPre;
    }
    // Merge tier の最終 danger-grep
    if (label === 'danger-grep-final') {
      return dangerGrepFinal;
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // one-shot security clearance（Merge tier）。agentType==='evaluator' だが label で区別する。
    if (agentType === 'evaluator' && label === 'security-clearance-final') {
      clearanceCalls.push({ prompt });
      return clearanceResponse;
    }
    // Evaluate 本体（label='eval#N'）
    if (agentType === 'evaluator') {
      evalCalls.push({ label, agentType });
      return evaluatorResponse;
    }
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    if (agentType === 'dev-runner-haiku-ro' && label === 'realized-diff') {
      return { files: ['src/foo.ts'] };
    }
    if (agentType === 'dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['src/foo.ts'] };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 16, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    if (label === 'ci-checks') {
      return { ok: false, error: 'stub: no checks' };
    }
    if (label === 'post-summary' && agentType === 'dev-runner') {
      summaryPrompts.push(prompt);
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
    args: '16',
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
      clearanceCalls: () => clearanceCalls.length,
      clearancePrompts: () => clearanceCalls.map((c) => c.prompt),
      journalPrompts: () => journalPrompts,
      summaryPrompts: () => summaryPrompts,
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
// 固定データ
// ============================================================

// complex に落ちる req（AC 満たし済みで danger 以外の HOLD 要因を混入させない）。
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 7,
  shape: 'complex',
};

const DANGER_CLEAN = { ok: true, hits: [] };
const DANGER_HIT_CONFIG = { ok: true, hits: [{ class: 'config', file: 'x', pattern: 'p' }] };
const DANGER_FAIL_CLOSED = { ok: false, hits: [], error: 'stub fail-closed' };

const EVAL_RESPONSE_CLEAN = {
  verdict: 'pass',
  total: 100,
  threshold: 80,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [],
};

// ============================================================
// シナリオ 1: PR #16 再現 — Evaluate 前 clean、Merge tier 最終 danger-grep で新規 hit。
// clearance が cleared:true + 非空 evidence を返す → checked → HOLD 回避。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ1: PR#16 再現 — cleared:true+evidence で HOLD 回避し footer が一致する', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const clearanceResponse = {
    security_clearance: [{ danger_class: 'config', cleared: true, evidence: 'diff 精査: secret 平文なし' }],
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_HIT_CONFIG, EVAL_RESPONSE_CLEAN, clearanceResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.clearanceCalls(),
    1,
    `新規 danger hit があるため security-clearance-final はちょうど 1 回呼ばれるべきだが ${counters.clearanceCalls()} 回だった`,
  );
  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `cleared:true + 非空 evidence の one-shot clearance で SEC-CONFIG が解消されるため merge tier は HOLD にならないはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`,
  );

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1, `journal-log は 1 回呼ばれるべきだが ${journalPrompts.length} 回だった`);
  assert.ok(
    !journalPrompts[0].includes('"merge_tier":"HOLD"'),
    `journal-log prompt の merge_tier は HOLD であってはならない。prompt:\n${journalPrompts[0]}`,
  );

  const summaryPrompts = counters.summaryPrompts();
  assert.equal(summaryPrompts.length, 1, `post-summary は 1 回呼ばれるべきだが ${summaryPrompts.length} 回だった`);
  assert.ok(
    !summaryPrompts[0].includes('❌ 未確認 | config'),
    `post-summary body に未確認 clearance テーブル行 '❌ 未確認 | config' が含まれてはならない。body:\n${summaryPrompts[0]}`,
  );
  assert.ok(
    summaryPrompts[0].includes('Security clearance 1/1 cleared'),
    `post-summary body に 'Security clearance 1/1 cleared' が含まれるべき。body:\n${summaryPrompts[0]}`,
  );
});

// ============================================================
// シナリオ 2: clearance が cleared:false を返す → SEC item unchecked のまま HOLD。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ2: cleared:false — SEC-CONFIG unchecked のまま HOLD になる', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const clearanceResponse = {
    security_clearance: [{ danger_class: 'config', cleared: false, evidence: '' }],
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_HIT_CONFIG, EVAL_RESPONSE_CLEAN, clearanceResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(counters.clearanceCalls(), 1, `security-clearance-final は 1 回呼ばれるべきだが ${counters.clearanceCalls()} 回だった`);
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `cleared:false の場合 SEC-CONFIG は unchecked のまま据え置かれ HOLD になるべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// シナリオ 3: clearance が null を返す → SEC item unchecked のまま HOLD。workflow は完走する。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ3: clearance null — HOLD かつ workflow は完走する', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_HIT_CONFIG, EVAL_RESPONSE_CLEAN, null);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(counters.clearanceCalls(), 1, `security-clearance-final は 1 回呼ばれるべきだが ${counters.clearanceCalls()} 回だった`);
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `clearance が null の場合 SEC-CONFIG は unchecked のまま据え置かれ HOLD になるべきだが '${result?.merge_tier}' だった`,
  );
  assert.ok(result != null, 'clearance が null でも workflow は throw せず完走し、return object を返すべき');
});

// ============================================================
// シナリオ 4: danger-grep-final が fail-closed → one-shot clearance を試みず、
// 全 SEC seed unchecked で HOLD を強制する（security floor 不変）。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ4: danger-grep-final fail-closed — clearance は呼ばれず HOLD 強制', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const clearanceResponse = {
    security_clearance: [{ danger_class: 'config', cleared: true, evidence: 'should not be called' }],
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN, clearanceResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.clearanceCalls(),
    0,
    `danger-grep-final が fail-closed の場合 security-clearance-final は呼ばれないはずだが ${counters.clearanceCalls()} 回呼ばれた`,
  );
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `danger-grep-final fail-closed の場合、merge tier は HOLD を強制すべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// シナリオ 5: 両方 clean（回帰） — clearance は呼ばれず、danger 起因の HOLD にならない。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ5 regression: Evaluate 前・Merge tier 最終ともに clean — clearance 呼び出しなし、HOLD にならない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_CLEAN, EVAL_RESPONSE_CLEAN, null);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.clearanceCalls(),
    0,
    `danger-grep が Evaluate 前・Merge tier 最終ともに clean の場合、SEC item は newly-unchecked にならず clearance は呼ばれないはずだが ${counters.clearanceCalls()} 回呼ばれた`,
  );
  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `danger が両方 clean の場合、merge tier は danger 起因で HOLD になるべきでないが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`,
  );
});
