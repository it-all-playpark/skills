// Issue #444: Evaluate ループ内 per-AC redgreen-verify 起動ガードに、deterministic 昇格済み
// AC への skip 条件を追加する回帰テスト。
//
// _lib/redgreen-vdelta-deny-routing.test.mjs（VM sandbox で dev-flow.js を読み込み、agent() を
// label/agentType で stub、log() 捕捉、journal-log prompt から telemetry handoff JSON を抽出する
// makeSandbox パターン）と _lib/eval-convergence.test.mjs（shape:'complex' で evaluator 応答を
// 呼び出し回数 index で切り替える responses 配列パターン）を組み合わせる。
//
// このテストファイルは TDD red として作成された。dev-flow.js の W4 ac_results ループ先頭ガードに
// 「acItem.checked === true && acItem.check?.kind === 'deterministic' なら skip」条件を追加する
// 実装完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helper ----

/**
 * redgreen-skip 専用の VM sandbox を組む。
 * evaluator 応答を呼び出し回数の index で切り替え、redgreen-verify.sh 呼び出し（label が
 * 'redgreen:AC-' で始まる）を ac_index・当該 AC の呼び出し回数（1始まり）別に記録・応答を切り替える。
 *
 * @param {object} analyzeReq
 * @param {object[]} evaluatorResponses - evaluator stub が呼び出し回数 index に応じて順に返す応答配列
 * @param {(acIndex:number, callNumber:number) => object} redgreenResponseFor - ac_index(0始まり)・
 *   当該 AC の呼び出し回数(1始まり) を受け取り redgreen stub の返り値を返す
 */
function makeSandbox(analyzeReq, evaluatorResponses, redgreenResponseFor) {
  const logs = [];
  const journalPrompts = [];
  const evalCalls = [];
  const redgreenCalls = [];
  const acCallCounts = {};

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
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      evalCalls.push({ label, agentType });
      const idx = Math.min(evalCalls.length - 1, evaluatorResponses.length - 1);
      return evaluatorResponses[idx];
    }
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen:AC-')) {
      const m = label.match(/^redgreen:AC-(\d+)$/);
      const acIndex = m ? Number(m[1]) - 1 : 0;
      acCallCounts[acIndex] = (acCallCounts[acIndex] ?? 0) + 1;
      const callNumber = acCallCounts[acIndex];
      redgreenCalls.push({ acIndex, callNumber });
      return redgreenResponseFor(acIndex, callNumber);
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
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: (m) => logs.push(String(m)),
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
      logs: () => logs,
      journalPrompts: () => journalPrompts,
      redgreenCalls: () => redgreenCalls,
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

const ANALYZE_REQ_1AC = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 7,
  shape: 'complex',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const CLEAN_VERDICT = { comparability: 'exact', transitions: {}, verification_surface: { status: 'intact' } };

const AC1_TEST_VERIFIED = { ac_index: 0, satisfied: true, verified_by: 'test', test_files: ['t0.test.mjs'], impl_files: ['impl0.mjs'] };

function criticalFirstIter() {
  return {
    verdict: 'needs_work',
    total: 60,
    feedback: [{ severity: 'critical', topic: 'X', dimension: 'eval', description: '重大欠陥', suggestion: '修正せよ' }],
    feedback_level: 'implementation',
    ac_results: [AC1_TEST_VERIFIED],
    security_clearance: [],
    testsurf_clearance: [],
  };
}

function resolvedSecondIter() {
  return {
    verdict: 'pass',
    total: 90,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: [AC1_TEST_VERIFIED],
    security_clearance: [],
    testsurf_clearance: [],
    critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'fixed' }],
  };
}

// ============================================================
// テストケース
// ============================================================

test('[redgreen-skip] T1: deterministic 昇格 + checked 済み AC は iteration2 で redgreen 再起動されない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const responses = [criticalFirstIter(), resolvedSecondIter()];
  const redgreenResponseFor = () => ({ red: true, green: true, verdict: CLEAN_VERDICT });

  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, responses, redgreenResponseFor);
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.redgreenCalls().length,
    1,
    `redgreen は AC-1 deterministic 昇格後は再実行されないべきだが ${counters.redgreenCalls().length} 回呼ばれた: ${JSON.stringify(counters.redgreenCalls())}`,
  );
  assert.equal(
    counters.evaluatorCalls(),
    2,
    `critical_resolutions 明示解消 + AC-1 skip で 2 回で収束すべきだが ${counters.evaluatorCalls()} 回だった`,
  );

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: deterministic 昇格 + checked 済み → redgreen-verify skip（issue #444）')),
    `iteration2 で skip ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-skip] T2: telemetry 固定 — skip 分は vdelta_verdicts に追記せず vdelta_fail_open/redgreen_deny も増えない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const responses = [criticalFirstIter(), resolvedSecondIter()];
  const redgreenResponseFor = () => ({ red: true, green: true, verdict: CLEAN_VERDICT });

  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, responses, redgreenResponseFor);
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1);
  const payloadMatch = journalPrompts[0].match(/\{"skill":"dev-flow".*\}/);
  assert.ok(payloadMatch, 'journal-log prompt から telemetry handoff JSON payload を抽出できなかった');
  const payload = JSON.parse(payloadMatch[0]);

  assert.equal(
    payload.telemetry.vdelta_verdicts.length,
    1,
    `vdelta_verdicts は初回 iteration 分の 1 要素のみを保持すべきだが: ${JSON.stringify(payload.telemetry.vdelta_verdicts)}`,
  );
  assert.deepEqual(payload.telemetry.vdelta_verdicts.map((v) => v.ac), ['AC-1']);
  assert.ok(!('vdelta_fail_open' in payload.telemetry), 'skip は vdelta_fail_open を増やさないべき');
  assert.ok(!('redgreen_deny' in payload.telemetry), 'skip は redgreen_deny を増やさないべき');
});

test('[redgreen-skip] T3: inspection 据え置き AC（checked だが kind!==deterministic）は従来どおり再実行される', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const responses = [criticalFirstIter(), resolvedSecondIter()];
  const redgreenResponseFor = (acIndex, callNumber) => (
    callNumber === 1 ? { red: false, green: true, reason: 'no red' } : { red: true, green: true }
  );

  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, responses, redgreenResponseFor);
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.redgreenCalls().length,
    2,
    `checked=true でも check.kind が deterministic でなければ再実行されるべきだが ${counters.redgreenCalls().length} 回だった: ${JSON.stringify(counters.redgreenCalls())}`,
  );

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `iteration2 で red→green 実証・昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-skip] T4: 未 checked AC は従来どおり起動される', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const firstIter = {
    verdict: 'needs_work',
    total: 60,
    feedback: [{ severity: 'critical', topic: 'X', dimension: 'eval', description: '重大欠陥', suggestion: '修正せよ' }],
    feedback_level: 'implementation',
    ac_results: [{ ac_index: 0, satisfied: false, verified_by: 'none', evidence: '' }],
    security_clearance: [],
    testsurf_clearance: [],
  };
  const responses = [firstIter, resolvedSecondIter()];
  const redgreenResponseFor = () => ({ red: true, green: true, verdict: CLEAN_VERDICT });

  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, responses, redgreenResponseFor);
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.redgreenCalls().length,
    1,
    `未 checked AC は iteration2 の 1 回のみ起動されるべきだが ${counters.redgreenCalls().length} 回だった: ${JSON.stringify(counters.redgreenCalls())}`,
  );
  assert.equal(counters.evaluatorCalls(), 2);
});
