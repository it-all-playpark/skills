// issue #405: Merge tier phase に追加した gh-pr-view exec-proxy 配線
// （agent → classifyMergeableState → classifyMergeTier）の VM sandbox 統合テスト。
//
// _lib/merge-tier.test.mjs は classifyMergeableState / classifyMergeTier という pure 関数のみを
// pin しており、dev-flow.js 側の実際の agent() dispatch（agentType/schema/label/phase）や
// conflict→HOLD / clean・unknown→no-op の end-to-end 伝播は未検証だった（PR #406 レビュー指摘）。
// 本ファイルは _lib/merge-tier-security-clearance-routing.test.mjs / _lib/ci-checks-routing.test.mjs
// と同じ VM sandbox パターン（node:vm で .claude/workflows/dev-flow.js を読み込み、agent() を
// label/agentType で stub）で以下を pin する:
//
//   (1) dispatch pin: label==='gh-pr-view' の呼び出しが agentType:'dev-runner-haiku-ro'・
//       phase:'Merge tier'・schema（PR_META: required ['ok'], properties.mergeable/mergeStateStatus/
//       error）・prompt に `gh pr view <pr番号> --json mergeable,mergeStateStatus` を含むことを検証する。
//   (2) conflicting(mergeable=CONFLICTING) → merge_tier HOLD、reasons に conflict 文言。
//   (3) conflicting(mergeStateStatus=DIRTY, mergeable 未設定) → merge_tier HOLD。
//   (4) clean(mergeable=MERGEABLE) → merge_tier は conflict 起因で HOLD にならない（no-op）。
//   (5) unknown(ok:false / proxy 失敗) → fail-open、merge_tier は conflict 起因で HOLD にならない。
//   (6) gh-pr-view は shape/danger 状態によらず Merge tier phase で必ず 1 回呼ばれる（無条件 dispatch）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// standard に落ちる req（count=3 ≤ 5, ac.length=1, type=fix → floor='standard'。danger clean +
// AC satisfied + breaking なしで、gh-pr-view が clean/unknown を返す限り baseline は REVIEW になる）。
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

function createResponder(prMetaResponse) {
  return function (prompt, opts) {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-405' };
    }
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
      return { files: ['src/x.ts'] };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 405, committed: true };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't1', files: ['src/x.ts'], summary: 's', concerns: [] };
    // gh-pr-view (issue #405): シナリオ別の応答
    if (label === 'gh-pr-view') return prMetaResponse;
    return null;
  };
}

function makeSandbox(prMetaResponse) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: opts?.label ?? '', agentType: opts?.agentType ?? '', phase: opts?.phase ?? '', schema: opts?.schema, prompt: prompt ?? '' });
    const result = createResponder(prMetaResponse)(prompt, opts);
    return result === undefined ? null : result;
  };
  const parallel = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflow = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent,
    parallel,
    workflow,
    args: '405',
    console, JSON, Math, String, Number, Boolean, Array, Object, Error, RegExp, Promise, Symbol, Map, Set, Date,
  };
  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// (1) dispatch pin
// ============================================================

test('[gh-pr-view][1] dispatch: agentType=dev-runner-haiku-ro, phase=Merge tier, schema(PR_META), prompt に gh pr view コマンドを含む', async () => {
  const { ctx, calls } = makeSandbox({ ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '1');

  const ghCalls = calls.filter((c) => c.label === 'gh-pr-view');
  assert.equal(ghCalls.length, 1, `label==='gh-pr-view' の呼び出しはちょうど 1 回のはずだが ${ghCalls.length} 回だった`);
  const c = ghCalls[0];
  assert.equal(c.agentType, 'dev-runner-haiku-ro', `gh-pr-view の agentType は 'dev-runner-haiku-ro' のはずだが '${c.agentType}' だった`);
  assert.equal(c.phase, 'Merge tier', `gh-pr-view の phase は 'Merge tier' のはずだが '${c.phase}' だった`);
  assert.ok(c.schema != null, 'gh-pr-view の schema (PR_META) が undefined/null になっている');
  assert.deepEqual(c.schema.required, ['ok'], `PR_META.required は ['ok'] のはずだが ${JSON.stringify(c.schema.required)}`);
  assert.ok(
    'mergeable' in c.schema.properties && 'mergeStateStatus' in c.schema.properties && 'error' in c.schema.properties,
    `PR_META.properties に mergeable/mergeStateStatus/error が揃っていない: ${JSON.stringify(Object.keys(c.schema.properties ?? {}))}`,
  );
  assert.ok(
    c.prompt.includes('gh pr view 405 --json mergeable,mergeStateStatus'),
    `gh-pr-view の prompt に gh pr view コマンドが含まれていない:\n${c.prompt}`,
  );
});

// ============================================================
// (2) conflicting(mergeable=CONFLICTING) → HOLD
// ============================================================

test('[gh-pr-view][2] mergeable=CONFLICTING → merge_tier=HOLD、reasons に conflict 文言', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '2');

  assert.equal(result?.merge_tier, 'HOLD', `mergeable=CONFLICTING の場合 merge_tier は HOLD のはずだが '${result?.merge_tier}' だった`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('base branch と conflict')),
    `merge_tier_reasons に conflict 文言が含まれていない: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (3) conflicting(mergeStateStatus=DIRTY のみ) → HOLD
// ============================================================

test('[gh-pr-view][3] mergeStateStatus=DIRTY(mergeable 未設定) → merge_tier=HOLD', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeStateStatus: 'DIRTY' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '3');

  assert.equal(result?.merge_tier, 'HOLD', `mergeStateStatus=DIRTY の場合 merge_tier は HOLD のはずだが '${result?.merge_tier}' だった`);
});

// ============================================================
// (4) clean(mergeable=MERGEABLE) → no-op（回帰）
// ============================================================

test('[gh-pr-view][4] regression: mergeable=MERGEABLE(clean) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '4');

  assert.equal(result?.merge_tier, 'REVIEW', `clean 状態(standard shape, 収束済)なら merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('conflict')),
    `clean 状態なのに merge_tier_reasons に conflict 文言が含まれている: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (5) unknown(ok:false / proxy 失敗) → fail-open no-op
// ============================================================

test('[gh-pr-view][5] fail-open: gh-pr-view が ok:false(proxy 失敗) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox({ ok: false, error: 'stub: gh pr view failed' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5-ok-false');

  assert.equal(result?.merge_tier, 'REVIEW', `proxy 失敗(ok:false)は fail-open のため merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('conflict')),
    `proxy 失敗なのに merge_tier_reasons に conflict 文言が含まれている: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

test('[gh-pr-view][5] fail-open: gh-pr-view が null(agent throw 等) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox(null);
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5-null');

  assert.equal(result?.merge_tier, 'REVIEW', `gh-pr-view が null の場合も fail-open のため merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
});

// ============================================================
// (6) mergeable=UNKNOWN(GitHub 側 mergeability 未計算) → fail-open no-op
// ============================================================

test('[gh-pr-view][6] fail-open: mergeable=UNKNOWN(GitHub 側未計算) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '6');

  assert.equal(result?.merge_tier, 'REVIEW', `mergeable=UNKNOWN は fail-open のため merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
});
