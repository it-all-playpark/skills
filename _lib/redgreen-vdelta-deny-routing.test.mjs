// Issue #362: redgreen R1↔R2 vdelta verdict による deny-only チェックの workflow レベル統合テスト。
//
// _lib/danger-fail-closed-loop-routing.test.mjs の VM sandbox パターン（node:vm で dev-flow.js を
// 読み込み、agent() を label/agentType で stub、log() 出力を捕捉して deterministic 昇格 / deny を
// 判別、journal-log prompt を捕捉して telemetry handoff JSON を assert）を踏襲する。
//
// このテストファイルは TDD red として作成された。F4 実装（dev-flow.js への redgreen deny 配線）
// 完了後に green になる。

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
 * redgreen/vdelta 専用の VM sandbox を組む。
 * evaluator の ac_results に対応する redgreen-verify.sh 呼び出し（label が 'redgreen:AC-' で
 * 始まる）の応答を acIndex 別に切り替え可能にし、log() 出力・journal-log prompt を捕捉する。
 *
 * @param {object} analyzeReq
 * @param {object} evaluatorResponse
 * @param {(acIndex:number) => object} redgreenResponseFor - ac_index(0始まり) を受け取り redgreen stub の返り値を返す
 */
function makeSandbox(analyzeReq, evaluatorResponse, redgreenResponseFor) {
  const logs = [];
  const journalPrompts = [];
  const evalCalls = [];

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
      return evaluatorResponse;
    }
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen:AC-')) {
      const m = label.match(/^redgreen:AC-(\d+)$/);
      const acIndex = m ? Number(m[1]) - 1 : 0;
      return redgreenResponseFor(acIndex);
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
  estimated_change_file_count: 3,
  shape: 'standard',
};

const ANALYZE_REQ_2AC = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

function evalTestVerified(acCount) {
  return {
    verdict: 'pass',
    total: 100,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: Array.from({ length: acCount }, (_, i) => ({
      ac_index: i,
      satisfied: true,
      verified_by: 'test',
      test_files: [`t${i}.test.mjs`],
      impl_files: [`impl${i}.mjs`],
    })),
    security_clearance: [],
    testsurf_clearance: [],
  };
}

// ============================================================
// テストケース
// ============================================================

test('[redgreen-vdelta] (a) verdict 無し（{red:true,green:true}のみ）→ 素の昇格（deterministic 昇格 + checked ログ）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `verdict 無しなら素の昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-vdelta] (b) verdict clean object → 昇格（deterministic 昇格 + checked ログ）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const cleanVerdict = { comparability: 'exact', transitions: {}, verification_surface: { status: 'intact' } };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true, verdict: cleanVerdict }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `verdict clean なら昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-vdelta] (c) verdict deny 対象（repaired_with_test_change + surface changed）→ 昇格不発 + telemetry redgreen_deny', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const denyVerdict = {
    comparability: 'exact',
    transitions: { repaired_with_test_change: ['t1'] },
    verification_surface: { status: 'changed' },
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true, verdict: denyVerdict }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    !logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `deny 対象なら deterministic 昇格ログは出ないべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
  assert.ok(
    logs.some((l) => l.includes('AC-1') && l.includes('vdelta deny')),
    `deny 対象なら vdelta deny ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1);
  assert.ok(journalPrompts[0].includes('"redgreen_deny"'), `journal-log prompt に '"redgreen_deny"' が含まれるべきだが含まれていなかった`);
  assert.ok(journalPrompts[0].includes('"ac":"AC-1"'), `journal-log prompt の redgreen_deny に ac:"AC-1" が含まれるべきだが含まれていなかった`);
});

test('[redgreen-vdelta] (d) verdict が不正 JSON 文字列 → fail-open で昇格 + telemetry vdelta_fail_open', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true, verdict: 'not-json{' }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `verdict が不正 JSON でも fail-open で昇格するべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1);
  assert.ok(journalPrompts[0].includes('"vdelta_fail_open"'), `journal-log prompt に '"vdelta_fail_open"' が含まれるべきだが含まれていなかった: ${journalPrompts[0]}`);
});

test('[redgreen-vdelta] (e) AC 2 件 → telemetry vdelta_verdicts が配列 2 要素（per-AC 上書き修正の検証）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const verdictFor = (i) => ({ comparability: 'exact', transitions: {}, verification_surface: { status: 'intact' }, note: `v${i}` });
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_2AC,
    evalTestVerified(2),
    (acIndex) => ({ red: true, green: true, verdict: verdictFor(acIndex) }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1);
  assert.ok(journalPrompts[0].includes('"vdelta_verdicts"'), `journal-log prompt に '"vdelta_verdicts"' が含まれるべきだが含まれていなかった`);
  const payloadMatch = journalPrompts[0].match(/\{"skill":"dev-flow".*\}/);
  assert.ok(payloadMatch, 'journal-log prompt から telemetry handoff JSON payload を抽出できなかった');
  const payload = JSON.parse(payloadMatch[0]);
  assert.equal(
    payload.telemetry.vdelta_verdicts.length,
    2,
    `vdelta_verdicts は AC 2 件分の要素を持つべきだが: ${JSON.stringify(payload.telemetry.vdelta_verdicts)}`,
  );
  const acs = payload.telemetry.vdelta_verdicts.map((v) => v.ac).sort();
  assert.deepEqual(acs, ['AC-1', 'AC-2']);
});
