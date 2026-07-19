// merge-tier-diffhash-reuse-routing: VM sandbox routing test for dev-flow の Security floor ↔
// Merge tier 間の diff-hash 一致による danger-grep-final / changed-files 再利用（issue #377）。
//
// Security floor phase（execSecurityFloorPhase）は danger-grep 成功時（risk.ok===true）かつ
// realized-diff 成功時のみ label 'diff-hash-secfloor' で tree OID を捕捉し state.secDiffHash に
// 保持する。Merge tier phase 冒頭は state.secDiffHash != null のときのみ label 'diff-hash-merge'
// で再度 tree OID を捕捉し、両ハッシュが文字列完全一致する場合のみ danger-grep-final /
// changed-files の再実行を skip して Security floor の risk/realized を再利用する
// （reuseSecFloor）。不一致・取得失敗・Security floor 側 fail-closed のときは現行どおり再実行し、
// security floor の fail-closed 性は一切変えない。
//
// ハーネスは _lib/ci-checks-routing.test.mjs の createResponder パターン（overrides の
// hasOwnProperty 優先チェック）+ _lib/test-helpers/vm-sandbox.mjs の makeRecordingSandbox、
// 実行部分は _lib/final-reconcile-routing.test.mjs のローカル runDevFlowCapture
// （{result, error} を返す vm 実行）を踏襲する。
//
// テストケース:
//   (1) 再利用発火: danger-grep clean + realized valid + secfloor hash===merge hash →
//       'danger-grep-final'/'changed-files'（Merge tier）は呼ばれず、'diff-hash-merge' は呼ばれ、
//       workflow は完走し merge_tier が算出される
//   (2) 不一致: secfloor='A' / merge='B' → 'danger-grep-final'/'changed-files' が呼ばれる
//   (3) merge 側取得失敗: 'diff-hash-merge' が null → 再実行（'danger-grep-final' が呼ばれる）
//   (4) Security floor fail-closed: danger-grep が {ok:false,hits:[]} → secDiffHash null →
//       'diff-hash-merge' は呼ばれず、'danger-grep-final' が呼ばれ、merge_tier が HOLD
//       （fail-closed 維持）
//   (5) 再利用発火 + Security floor hit: danger-grep が ok:true で危険クラス hit + 同一 hash →
//       再利用で 'danger-grep-final' 不発だが riskFinal に hit が残り merge_tier HOLD
//       （unresolvedDanger 維持）

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
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す
// （final-reconcile-routing.test.mjs / merge-tier-security-clearance-routing.test.mjs と同型）
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

// ============================================================
// responder factory: ci-checks-routing.test.mjs / final-reconcile-routing.test.mjs の
// createResponder パターンを踏襲。overrides は label 単位（関数なら
// ({prompt, agentType, label}) => ... として呼ばれる。throw も伝播）。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-377' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label === 'danger-grep') return { ok: true, hits: [] };
    if (label === 'danger-grep-final') return { ok: true, hits: [] };
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
    // diff-hash-secfloor / diff-hash-merge は既定で同一ハッシュ（再利用が発火する）。
    // 不一致にしたいテストは override で個別に上書きする。
    if (label === 'diff-hash-secfloor') return { hash: 'SAMEHASH', empty: false };
    if (label === 'diff-hash-merge') return { hash: 'SAMEHASH', empty: false };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    return null;
  };
}

function makeSandbox({ overrides = {} } = {}) {
  // fixes_applied=0 固定: Final reconcile は zero-overhead で skip され、Merge tier phase の
  // diff-hash reuse ロジックの検証に専念できる（final-reconcile-routing.test.mjs のケース(a)と同型）。
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 0 }),
    args: '377',
  });
}

// ============================================================
// (1) 再利用発火: 完全一致 → danger-grep-final/changed-files 再実行を skip
// ============================================================

test('[diffhash-reuse] (1) 完全一致 → danger-grep-final/changed-files は呼ばれず diff-hash-merge は呼ばれ、workflow 完走 + merge_tier 算出', async () => {
  const { ctx, calls } = makeSandbox();
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '1');
  assert.ok(result !== null, '(1) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'danger-grep-final'), "(1) hash 完全一致時は 'danger-grep-final' が呼ばれてはならない");
  assert.ok(!calls.some((c) => c.label === 'changed-files'), "(1) hash 完全一致時は 'changed-files'（Merge tier）が呼ばれてはならない");
  assert.ok(calls.some((c) => c.label === 'diff-hash-merge'), "(1) 'diff-hash-merge' は呼ばれるはず（再利用可否の判定に必須）");
  assert.ok(result?.merge_tier != null, `(1) merge_tier が算出されているはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(1) danger clean + 収束済みなら merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (2) 不一致 → 再実行
// ============================================================

test("[diffhash-reuse] (2) hash 不一致 → 'danger-grep-final'/'changed-files' が再実行される", async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'diff-hash-secfloor': { hash: 'A', empty: false },
      'diff-hash-merge': { hash: 'B', empty: false },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '2');
  assert.ok(result !== null, '(2) workflow は return object を返すべきだが null だった');

  assert.ok(calls.some((c) => c.label === 'danger-grep-final'), "(2) hash 不一致時は 'danger-grep-final' が再実行されるはず");
  assert.ok(calls.some((c) => c.label === 'changed-files'), "(2) hash 不一致時は 'changed-files'（Merge tier）が再実行されるはず");
});

// ============================================================
// (3) merge 側取得失敗 → 再実行
// ============================================================

test("[diffhash-reuse] (3) diff-hash-merge が null（取得失敗） → 再実行される", async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'diff-hash-merge': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '3');
  assert.ok(result !== null, '(3) workflow は return object を返すべきだが null だった');

  assert.ok(calls.some((c) => c.label === 'diff-hash-merge'), "(3) 'diff-hash-merge' 自体は呼ばれるはず（secDiffHash は有効）");
  assert.ok(calls.some((c) => c.label === 'danger-grep-final'), "(3) merge 側 hash 取得失敗時は 'danger-grep-final' が再実行されるはず");
  assert.ok(calls.some((c) => c.label === 'changed-files'), "(3) merge 側 hash 取得失敗時は 'changed-files'（Merge tier）が再実行されるはず");
});

// ============================================================
// (4) Security floor fail-closed → diff-hash-merge 不発 + danger-grep-final 再実行 + HOLD
// ============================================================

test("[diffhash-reuse] (4) Security floor fail-closed → 'diff-hash-merge' は呼ばれず 'danger-grep-final' が呼ばれ merge_tier HOLD（fail-closed 維持）", async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': { ok: false, hits: [], error: 'sec floor stub fail' },
      'danger-grep-final': { ok: false, hits: [], error: 'merge tier stub fail' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '4');
  assert.ok(result !== null, '(4) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'diff-hash-merge'), "(4) Security floor fail-closed（secDiffHash null）のとき 'diff-hash-merge' は呼ばれないはず");
  assert.ok(calls.some((c) => c.label === 'danger-grep-final'), "(4) 'danger-grep-final' は必ず再実行されるはず（security floor の fail-closed 性は緩めない）");
  assert.equal(result?.merge_tier, 'HOLD', `(4) danger-grep が両段で fail-closed のため merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (5) 再利用発火 + Security floor hit → HOLD（unresolvedDanger 維持）
// ============================================================

test("[diffhash-reuse] (5) hash 一致 + Security floor で danger hit → 再利用で 'danger-grep-final' 不発だが hit が残り merge_tier HOLD", async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': { ok: true, hits: [{ class: 'config', file: 'src/x.ts', pattern: 'p' }] },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5');
  assert.ok(result !== null, '(5) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'danger-grep-final'), "(5) hash 完全一致時は danger hit があっても 'danger-grep-final' が呼ばれてはならない（再利用）");
  assert.ok(calls.some((c) => c.label === 'diff-hash-merge'), "(5) 'diff-hash-merge' は呼ばれるはず");
  assert.equal(result?.merge_tier, 'HOLD', `(5) 再利用した risk に未解消の danger hit が残るため merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});
