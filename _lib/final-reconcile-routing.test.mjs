// final-reconcile-routing: VM sandbox routing test for dev-flow の Final reconcile phase
// （issue #320 F4）。pr-iterate が fix を適用した run（fixes_applied>0）のみ、worktree を
// PR 最終 HEAD へ ff-sync → test suite 一発再実行 → 最終 changed-files から UI touch /
// 宣言外パスを再判定 → 必要時 ui-verify 再実行を行い、classifyMergeTier / summary / telemetry /
// return へ配線されることを pin する。
//
// ハーネスは makeRecordingSandbox（_lib/test-helpers/vm-sandbox.mjs）を使い、
// ci-checks-routing.test.mjs の createResponder パターンを踏襲する。ただし return object
// を検証する必要があるため、実行部分は merge-tier-security-clearance-routing.test.mjs /
// ui-verify-routing.test.mjs と同型のローカル runDevFlowCapture（{result, error} を返す）を使う
// （vm-sandbox.mjs の共有 runDevFlowInSandbox は error のみを返すため）。
//
// テストケース:
//   (a) fixes_applied=0 → Final reconcile の agent は一切呼ばれず final_reconcile==='skipped'
//       + merge_tier は従来どおり（AC-1 cost regression）
//   (b) fixes=1 + sync ok + test#final green → final_reconcile==='reverified' + final_test_green===true
//       + merge_tier==='REVIEW'（AC-2）
//   (c) fixes=1 + test#final red → merge_tier==='HOLD' + reasons に 'final test red'（AC-3）
//   (d) fixes=1 + test#final null → final_reconcile==='unavailable' + HOLD + reasons に
//       'Final reconcile 再検証不能'（AC-3）
//   (e) fixes=1 + reconcile-sync 失敗 → unavailable + HOLD + calls に 'test#final' が現れない
//   (f) fixes=1 + changed-files-final が UI ファイルを返し ui-verify-config-final が有効 config
//       → ui-verify-server-final/ui-verify-final/ui-verify-teardown-final が呼ばれ
//       final_ui_verify が設定される（AC-4）+ journal-log prompt に 'final_reconcile'（AC-6）
//   (g) fixes=1 + 'ui-verify-final' が throw → teardown は呼ばれ workflow は完走、
//       final_ui_verify==='failed_open'（AC-7 fail-open + teardown 保証）
//   (h) calls 配列で 'danger-grep-final'/'changed-files'（Merge tier）が 'reconcile-sync' より後（AC-5）
//   (i) fixes=1 + changed-files-final null → final_reconcile==='reverified' のまま（fail-open）
//       + 'ui-verify-config-final' 不発
//   (j) fixes=1 + test#final throw(EPERM) → error===null（run 完走）+ unavailable + HOLD +
//       reasons に 'Final reconcile 再検証不能'（AC-4 throw fail-safe）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す（merge-tier-security-
// clearance-routing.test.mjs / ui-verify-routing.test.mjs と同型のローカル copy）
// ============================================================
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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

const VALID_CFG = {
  install_command: 'npm ci',
  dev_command: 'npm run dev -- --port {port}',
  base_port: 4100,
  ready_path: '/',
  env_files: [],
};

// ============================================================
// responder factory: ci-checks-routing.test.mjs の createResponder パターンを踏襲。
// overrides は label 単位（関数なら ({prompt, agentType, label}) => ... として呼ばれる。throw も伝播）。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-320' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/x.ts'] };
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    return null;
  };
}

function makeSandbox({ overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '320',
  });
}

// ============================================================
// (a) fixes_applied=0 → Final reconcile は zero-overhead（AC-1）
// ============================================================

test('[final-reconcile] (a) fixes_applied=0 → 新規 agent 呼び出しゼロ + final_reconcile===skipped + merge tier 不変', async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 0 });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  const finalLabels = ['reconcile-sync', 'test#final', 'changed-files-final', 'ui-verify-config-final', 'ui-verify-server-final', 'ui-verify-final', 'ui-verify-teardown-final'];
  for (const l of finalLabels) {
    assert.ok(!calls.some((c) => c.label === l), `(a) fixes_applied=0 では label==='${l}' の呼び出しが存在してはならない`);
  }
  assert.equal(result?.final_reconcile, 'skipped', `(a) final_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(a) merge tier は従来どおり REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (b) fixes=1 + sync ok + test#final green → reverified + final_test_green:true + REVIEW（AC-2）
// ============================================================

test('[final-reconcile] (b) fixes=1 + test green → reverified + final_test_green:true + merge_tier REVIEW', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  assert.ok(calls.some((c) => c.label === 'reconcile-sync'), "(b) 'reconcile-sync' が呼ばれるはず");
  assert.ok(calls.some((c) => c.label === 'test#final'), "(b) 'test#final' が呼ばれるはず");
  assert.equal(result?.final_reconcile, 'reverified', `(b) final_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.final_test_green, true, `(b) final_test_green は true のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(b) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (c) fixes=1 + test#final red → HOLD + reasons に 'final test red'（AC-3）
// ============================================================

test("[final-reconcile] (c) fixes=1 + test#final red → merge_tier HOLD + reasons に 'final test red'", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'failed', green: false, summary: 'boom' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_test_green, false, `(c) final_test_green は false のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(c) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(c) merge_tier_reasons に 'final test red' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (d) fixes=1 + test#final null → unavailable + HOLD + reasons に 'Final reconcile 再検証不能'（AC-3）
// ============================================================

test("[final-reconcile] (d) fixes=1 + test#final null → final_reconcile unavailable + HOLD", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'unavailable', `(d) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(d) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final reconcile 再検証不能')),
    `(d) merge_tier_reasons に 'Final reconcile 再検証不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (e) fixes=1 + reconcile-sync 失敗 → unavailable + HOLD + 'test#final' 不発
// ============================================================

test("[final-reconcile] (e) fixes=1 + reconcile-sync 失敗(non-ff) → unavailable + HOLD + test#final 不発", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'reconcile-sync': { ok: false, error: 'non-ff' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e');
  assert.ok(result !== null, '(e) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'unavailable', `(e) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(e) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(!calls.some((c) => c.label === 'test#final'), "(e) sync 失敗時は 'test#final' が呼ばれないはず");
});

// ============================================================
// (f) fixes=1 + UI ファイル変化 + 有効 ui-verify config → ui-verify-* -final 系が呼ばれる（AC-4）
//     + journal-log prompt に 'final_reconcile' が含まれる（AC-6）
// ============================================================

test('[final-reconcile] (f) fixes=1 + UI touch + 有効 config → ui-verify-*-final が呼ばれ final_ui_verify 設定 + journal-log に final_reconcile', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'changed-files-final': { files: ['src/components/A.tsx'] },
      'ui-verify-config-final': { found: true, config: VALID_CFG },
      'ui-verify-server-final': { ok: true, phase: 'ready', port: 4100, pid: 1234 },
      'ui-verify-final': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
      'ui-verify-teardown-final': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'f');
  assert.ok(result !== null, '(f) workflow は return object を返すべきだが null だった');

  for (const l of ['ui-verify-config-final', 'ui-verify-server-final', 'ui-verify-final', 'ui-verify-teardown-final']) {
    assert.ok(calls.some((c) => c.label === l), `(f) label==='${l}' が呼ばれるはず`);
  }
  assert.equal(result?.final_ui_verify, 'passed', `(f) final_ui_verify は 'passed' のはずだが ${JSON.stringify(result?.final_ui_verify)}`);

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(f) 'journal-log' の呼び出しが存在すること");
  assert.ok(journalCall.prompt.includes('final_reconcile'), "(f) journal-log prompt に 'final_reconcile' が含まれること（AC-6）");
});

// ============================================================
// (g) fixes=1 + 'ui-verify-final' throw → teardown は呼ばれ workflow は完走、failed_open（AC-7）
// ============================================================

test("[final-reconcile] (g) 'ui-verify-final' throw → teardown 実行 + workflow 完走 + final_ui_verify failed_open", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'changed-files-final': { files: ['src/components/A.tsx'] },
      'ui-verify-config-final': { found: true, config: VALID_CFG },
      'ui-verify-server-final': { ok: true, phase: 'ready', port: 4100, pid: 1234 },
      'ui-verify-final': () => { throw new Error('ui-verifier crashed (forced failure test)'); },
      'ui-verify-teardown-final': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.ok(calls.some((c) => c.label === 'ui-verify-final'), "(g) 'ui-verify-final' 呼び出しは発生しているはず");
  assert.ok(calls.some((c) => c.label === 'ui-verify-teardown-final'), "(g) throw しても 'ui-verify-teardown-final' は必ず呼ばれるはず（try/finally）");
  assert.equal(error, null, `(g) throw で run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(g) workflow は return object を返すべきだが null だった（run 全体が死んだことを示す）');
  assert.equal(result?.final_ui_verify, 'failed_open', `(g) final_ui_verify は 'failed_open' のはずだが ${JSON.stringify(result?.final_ui_verify)}`);
});

// ============================================================
// (h) calls 順序: 'danger-grep-final'/'changed-files'（Merge tier）は 'reconcile-sync' より後（AC-5）
// ============================================================

test("[final-reconcile] (h) calls 順序: Merge tier の 'danger-grep-final'/'changed-files' は 'reconcile-sync' より後", async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 1 });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h');

  const idxSync = calls.findIndex((c) => c.label === 'reconcile-sync');
  const idxDangerFinal = calls.findIndex((c) => c.label === 'danger-grep-final');
  const idxChanged = calls.findIndex((c) => c.label === 'changed-files');

  assert.ok(idxSync >= 0, "(h) 'reconcile-sync' の呼び出しが見つからない");
  assert.ok(idxDangerFinal >= 0, "(h) 'danger-grep-final' の呼び出しが見つからない");
  assert.ok(idxChanged >= 0, "(h) 'changed-files' の呼び出しが見つからない");
  assert.ok(idxDangerFinal > idxSync, "(h) 'danger-grep-final' は 'reconcile-sync' より後であるべき（Final reconcile 完了後の tree を対象にする、AC-5）");
  assert.ok(idxChanged > idxSync, "(h) 'changed-files'（Merge tier）は 'reconcile-sync' より後であるべき（AC-5）");
});

// ============================================================
// (i) fixes=1 + changed-files-final null → reverified のまま（fail-open）+ ui-verify-config-final 不発
// ============================================================

test('[final-reconcile] (i) fixes=1 + changed-files-final null → reverified 維持（fail-open）+ ui-verify-config-final 不発', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'changed-files-final': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'i');
  assert.ok(result !== null, '(i) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'reverified', `(i) changed-files-final 取得失敗でも final_reconcile は 'reverified' のままのはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.ok(!calls.some((c) => c.label === 'ui-verify-config-final'), "(i) changed-files-final が null なら 'ui-verify-config-final' は呼ばれないはず（fail-open）");
});

// ============================================================
// (j) fixes=1 + test#final throw(EPERM) → run 完走 + unavailable + HOLD（AC-4 throw fail-safe）
// ============================================================

test("[final-reconcile] (j) fixes=1 + test#final throw(EPERM) → run 完走 + final_reconcile unavailable + HOLD", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': () => { throw new Error('EPERM: operation not permitted (vitest node_modules/.vite-temp)'); },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `(j) test#final の throw で run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(j) workflow は return object を返すべきだが null だった（run 全体が死んだことを示す）');
  assert.equal(result?.final_reconcile, 'unavailable', `(j) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(j) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final reconcile 再検証不能')),
    `(j) merge_tier_reasons に 'Final reconcile 再検証不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});
