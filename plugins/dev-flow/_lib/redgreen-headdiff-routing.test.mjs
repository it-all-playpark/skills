// redgreen の test_cmd 経路未起動（testcmd_ran:false）invocation の計上と headdiff digest の
// telemetry 配線を pin する。VM sandbox パターンは _lib/redgreen-vdelta-deny-routing.test.mjs
// の makeSandbox / runDevFlowCapture / assertNoCrash / ANALYZE_REQ_1AC / evalTestVerified をそのまま
// 複製する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs } from './test-helpers/vm-sandbox.mjs';
import { isRedgreenCall, redgreenBatchResponse } from './test-helpers/redgreen-batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helper ----

/**
 * redgreen/vdelta 専用の VM sandbox を組む。
 * evaluator の ac_results に対応する redgreen-verify.sh バッチ呼び出し（label 'redgreen'、1 spawn に
 * 全 AC ペア）の応答を acIndex 別に切り替え可能にし、log() 出力・journal-log prompt を捕捉する。
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

    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      evalCalls.push({ label, agentType });
      return evaluatorResponse;
    }
    if (isRedgreenCall(agentType, label)) {
      return redgreenBatchResponse(prompt, evaluatorResponse.ac_results, (acIndex) => redgreenResponseFor(acIndex));
    }
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && label === 'realized-diff') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (agentType === 'dev-flow:dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }
    if (agentType === 'dev-flow:dev-implement-fable') {
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
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
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
  issue_number: 1,
  issue_title: 'stub-issue-title',
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
      test_files: [`t${i}.bats`],
      impl_files: [`impl${i}.mjs`],
    })),
    security_clearance: [],
    testsurf_clearance: [],
  };
}

function extractTelemetry(journalPrompts) {
  assert.equal(journalPrompts.length, 1);
  const payloadMatch = journalPrompts[0].match(/\{"skill":"dev-flow".*\}/);
  assert.ok(payloadMatch, 'journal-log prompt から telemetry handoff JSON payload を抽出できなかった');
  const payload = JSON.parse(payloadMatch[0]);
  return payload.telemetry;
}

// ============================================================
// テストケース
// ============================================================

test('[redgreen-headdiff] (a) testcmd_ran:false + headdiff clean(new>0) → 昇格 + vdelta_not_started=1 + redgreen_headdiff clean + vdelta_fail_open 無し', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_1AC,
    evalTestVerified(1),
    () => ({ red: true, green: true, testcmd_ran: false, headdiff: { new: 1, modified: 0, unchanged: 0, total: 1 } }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `testcmd_ran:false でも昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );

  const telemetry = extractTelemetry(counters.journalPrompts());
  assert.equal(telemetry.vdelta_not_started, 1);
  assert.deepEqual(telemetry.redgreen_headdiff, [{ ac: 'AC-1', status: 'clean', new: 1, modified: 0, unchanged: 0, total: 1, red: true, green: true }]);
  assert.equal('vdelta_fail_open' in telemetry, false);
});

test('[redgreen-headdiff] (b) testcmd_ran:false + headdiff modified>0 → 昇格維持（deny しない）+ redgreen_headdiff test_modified + redgreen_deny 無し', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_1AC,
    evalTestVerified(1),
    () => ({ red: true, green: true, testcmd_ran: false, headdiff: { new: 0, modified: 1, unchanged: 0, total: 1 } }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `test_modified でも deny せず昇格するべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );

  const telemetry = extractTelemetry(counters.journalPrompts());
  assert.equal(telemetry.redgreen_headdiff[0].status, 'test_modified');
  assert.equal(telemetry.redgreen_headdiff[0].red, true);
  assert.equal(telemetry.redgreen_headdiff[0].green, true);
  assert.equal('redgreen_deny' in telemetry, false);
});

test('[redgreen-headdiff] (f) testcmd_ran:false + headdiff modified>0 + red:false（未成立）→ 未昇格 + redgreen_headdiff に test_modified と red:false が両方残り「test 改変を伴う red→green」ではないと telemetry 単体で識別できる', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_1AC,
    evalTestVerified(1),
    () => ({ red: false, green: true, testcmd_ran: false, headdiff: { new: 0, modified: 1, unchanged: 0, total: 1 } }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 未成立')),
    `red:false は昇格しないべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );

  const telemetry = extractTelemetry(counters.journalPrompts());
  assert.deepEqual(telemetry.redgreen_headdiff, [{ ac: 'AC-1', status: 'test_modified', new: 0, modified: 1, unchanged: 0, total: 1, red: false, green: true }]);
});

test('[redgreen-headdiff] (c) testcmd_ran:true + verdict 無し → vdelta_fail_open=1、vdelta_not_started/redgreen_headdiff 無し', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_1AC,
    evalTestVerified(1),
    () => ({ red: true, green: true, testcmd_ran: true }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const telemetry = extractTelemetry(counters.journalPrompts());
  assert.equal(telemetry.vdelta_fail_open, 1);
  assert.equal('vdelta_not_started' in telemetry, false);
  assert.equal('redgreen_headdiff' in telemetry, false);
});

test('[redgreen-headdiff] (d) testcmd_ran:false + headdiff 欠落 → vdelta_not_started=1、redgreen_headdiff fail_open(件数全0)', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_1AC,
    evalTestVerified(1),
    () => ({ red: true, green: true, testcmd_ran: false }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const telemetry = extractTelemetry(counters.journalPrompts());
  assert.equal(telemetry.vdelta_not_started, 1);
  assert.deepEqual(telemetry.redgreen_headdiff, [{ ac: 'AC-1', status: 'fail_open', new: 0, modified: 0, unchanged: 0, total: 0, red: true, green: true }]);
});

test('[redgreen-headdiff] (e) testcmd_ran 欠落 → vdelta_fail_open=1（既存挙動 pin）、vdelta_not_started 無し', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_1AC,
    evalTestVerified(1),
    () => ({ red: true, green: true }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const telemetry = extractTelemetry(counters.journalPrompts());
  assert.equal(telemetry.vdelta_fail_open, 1);
  assert.equal('vdelta_not_started' in telemetry, false);
});
