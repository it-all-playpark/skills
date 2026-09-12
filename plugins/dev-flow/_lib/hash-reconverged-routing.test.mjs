// hash-reconverged-routing: VM sandbox routing test for dev-flow の hash_reconverged 判定
// （issue #631）。hash_mismatch 検出直後（PR phase）の tree-diff-numstat probe と、Merge tier
// phase の head-tree-oid probe + 3 条件（evalStaleness==='hash_mismatch' && prHeadTreeOid===
// evalDiffHash && mergeDiffHash===evalDiffHash）による hash_reconverged への置換を検証する。
//
// ハーネスは _lib/merge-tier-diffhash-reuse-routing.test.mjs の makeRecordingSandbox（共有
// test-helpers/vm-sandbox.mjs）+ ローカル runDevFlowCapture / assertNoCrash / createResponder
// パターンを踏襲する。
//
// テストケース:
//   (a) 既定（3 条件成立）→ hash_reconverged、merge_tier=REVIEW、hash_mismatch reason なし、
//       tree-diff-numstat / head-tree-oid とも 1 回、post-summary prompt に「PR head tree は
//       評価済み tree と一致」を含み「Evaluate は古い tree に対して実行された」を含まない
//   (b) head-tree-oid が evalDiffHash と不一致（prHeadTreeOid!==evalDiffHash、mergeDiffHash
//       ===evalDiffHash）→ hash_mismatch 維持・HOLD
//   (c) diff-hash-merge が null（mergeDiffHash null）→ hash_mismatch 維持・HOLD・head-tree-oid
//       は 0 回（zero-overhead）
//   (d) gh-pr-view から headRefOid が取得できない → hash_mismatch 維持・HOLD・head-tree-oid 0 回
//   (d') head-tree-oid 自体が取得失敗（null）→ hash_mismatch 維持・HOLD
//   (e) tree-diff-numstat が取得失敗しても hash_reconverged 判定は妨げられない。また (b) 相当の
//       不一致 + numstat 失敗で HOLD reason に手動確認コマンドが載る
//   (f) dispatch pin: tree-diff-numstat / head-tree-oid / gh-pr-view の agentType・prompt
//   (g) hash 不一致なし（diff-hash-pr===diff-hash-eval）→ tree-diff-numstat / head-tree-oid とも
//       0 回、eval_staleness='none'
//   (h) fixes_applied>0 でも 3 条件成立なら hash_reconverged（判定は 3 条件のみ）

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
// （merge-tier-diffhash-reuse-routing.test.mjs と同型）
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

const HEAD_REF_OID = 'a'.repeat(40);

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 631,
  issue_title: 'stub-issue-title',
};

// ============================================================
// responder factory: merge-tier-diffhash-reuse-routing.test.mjs の createResponder を踏襲。
// 既定で hash_mismatch を必ず発生させ（diff-hash-eval='AAA' / diff-hash-pr='BBB'）、
// head-tree-oid / diff-hash-merge を eval と一致させて 3 条件成立（hash_reconverged）を既定にする。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-631' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'AAA', empty: false } };
    }
    if (label === 'danger-grep-final') return { ok: true, hits: [] };
    if (agentType === 'dev-flow:evaluator') {
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
    if (label === 'diff-hash-eval') return { hash: 'AAA', empty: false };
    if (label === 'diff-hash-pr') return { hash: 'BBB', empty: false };
    if (label === 'diff-hash-merge') return { hash: 'AAA', empty: false };
    if (label === 'gh-pr-view') return { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID };
    if (label === 'tree-diff-numstat') return { ok: true, lines: ['0\t500\tdocs/a.md', '0\t360\tdocs/b.md'] };
    if (label === 'head-tree-oid') return { ok: true, tree: 'AAA' };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 631, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {}, workflow } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: workflow ?? (async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 })),
    args: '631',
  });
}

// ============================================================
// (a) 既定（3 条件成立） → hash_reconverged
// ============================================================

test('[hash-reconverged] (a) 既定(3条件成立) → eval_staleness=hash_reconverged、merge_tier=REVIEW、hash_mismatch reason なし、probe 各1回、post-summary に再収束文言', async () => {
  const { ctx, calls } = makeSandbox();
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_reconverged', `(a) eval_staleness は hash_reconverged のはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(a) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('hash_mismatch')),
    `(a) merge_tier_reasons に hash_mismatch を含む要素があってはならない: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );

  const numstatCalls = calls.filter((c) => c.label === 'tree-diff-numstat');
  const headTreeCalls = calls.filter((c) => c.label === 'head-tree-oid');
  assert.equal(numstatCalls.length, 1, `(a) tree-diff-numstat はちょうど 1 回のはずだが ${numstatCalls.length} 回`);
  assert.equal(headTreeCalls.length, 1, `(a) head-tree-oid はちょうど 1 回のはずだが ${headTreeCalls.length} 回`);

  const postSummary = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, '(a) post-summary が呼ばれていない');
  assert.ok(postSummary.prompt.includes('PR head tree は評価済み tree と一致'), `(a) post-summary prompt に再収束文言が無い:\n${postSummary.prompt}`);
  assert.ok(!postSummary.prompt.includes('Evaluate は古い tree に対して実行された'), '(a) post-summary prompt に hash_mismatch の警告文言が残っている');
});

// ============================================================
// (b) prHeadTreeOid !== evalDiffHash → hash_mismatch 維持
// ============================================================

test('[hash-reconverged] (b) head-tree-oid が evalDiffHash と不一致 → hash_mismatch 維持・HOLD・両hashと差分ファイルを含む', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'head-tree-oid': { ok: true, tree: 'BBB' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(b) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(b) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  const reasons = result?.merge_tier_reasons ?? [];
  assert.ok(
    reasons.some((r) => r.includes('hash_mismatch') && r.includes('docs/a.md (+0/-500)') && r.includes('AAA') && r.includes('BBB')),
    `(b) merge_tier_reasons に hash_mismatch + docs/a.md (+0/-500) + AAA + BBB を含む要素が無い: ${JSON.stringify(reasons)}`,
  );

  assert.equal(calls.filter((c) => c.label === 'head-tree-oid').length, 1, '(b) head-tree-oid は 1 回呼ばれるはず');
});

// ============================================================
// (c) mergeDiffHash null → hash_mismatch 維持・head-tree-oid 0 回
// ============================================================

test('[hash-reconverged] (c) diff-hash-merge が null(mergeDiffHash null) → hash_mismatch 維持・HOLD・head-tree-oid は 0 回', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'diff-hash-merge': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(c) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(c) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(calls.filter((c) => c.label === 'head-tree-oid').length, 0, '(c) mergeDiffHash が null のとき head-tree-oid は呼ばれてはならない（zero-overhead）');
});

// ============================================================
// (d) headRefOid 欠落 → hash_mismatch 維持・head-tree-oid 0 回
// ============================================================

test('[hash-reconverged] (d) gh-pr-view に headRefOid が無い → hash_mismatch 維持・HOLD・head-tree-oid は 0 回', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'gh-pr-view': { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(d) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(d) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(calls.filter((c) => c.label === 'head-tree-oid').length, 0, '(d) headRefOid 欠落時は head-tree-oid は呼ばれてはならない');
});

// ============================================================
// (d') head-tree-oid 取得失敗（null） → hash_mismatch 維持
// ============================================================

test("[hash-reconverged] (d') head-tree-oid が null(取得失敗) → hash_mismatch 維持・HOLD", async () => {
  const { ctx } = makeSandbox({
    overrides: { 'head-tree-oid': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, "d'");
  assert.ok(result !== null, "(d') workflow は return object を返すべきだが null だった");

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(d') eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(d') merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (e) tree-diff-numstat 失敗は hash_reconverged 判定を妨げない／不一致時は手動確認コマンドを出す
// ============================================================

test('[hash-reconverged] (e) tree-diff-numstat が null でも 3 条件成立なら hash_reconverged になる（差分取得失敗は再収束判定を妨げない）', async () => {
  const { ctx } = makeSandbox({
    overrides: { 'tree-diff-numstat': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e-1');
  assert.ok(result !== null, '(e-1) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_reconverged', `(e-1) eval_staleness は hash_reconverged のはずだが ${JSON.stringify(result?.eval_staleness)}`);
});

test('[hash-reconverged] (e) tree-diff-numstat が null + head-tree-oid 不一致 → HOLD reason に git diff --stat と手動確認を含む', async () => {
  const { ctx } = makeSandbox({
    overrides: {
      'tree-diff-numstat': null,
      'head-tree-oid': { ok: true, tree: 'BBB' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e-2');
  assert.ok(result !== null, '(e-2) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(e-2) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  const reasons = result?.merge_tier_reasons ?? [];
  assert.ok(
    reasons.some((r) => r.includes('git diff --stat AAA BBB') && r.includes('手動確認')),
    `(e-2) merge_tier_reasons に手動確認コマンドが含まれていない: ${JSON.stringify(reasons)}`,
  );
});

// ============================================================
// (f) dispatch pin
// ============================================================

test('[hash-reconverged] (f) dispatch pin: tree-diff-numstat / head-tree-oid / gh-pr-view の agentType・prompt', async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'f');

  const numstatCall = calls.find((c) => c.label === 'tree-diff-numstat');
  assert.ok(numstatCall != null, '(f) tree-diff-numstat が呼ばれていない');
  assert.equal(numstatCall.agentType, 'dev-flow:dev-runner-haiku-ro', `(f) tree-diff-numstat の agentType が期待と不一致: ${numstatCall.agentType}`);
  assert.ok(
    numstatCall.prompt.includes('git -C /tmp/wt diff --numstat AAA BBB'),
    `(f) tree-diff-numstat の prompt に git diff --numstat コマンドが含まれていない:\n${numstatCall.prompt}`,
  );

  const headTreeCall = calls.find((c) => c.label === 'head-tree-oid');
  assert.ok(headTreeCall != null, '(f) head-tree-oid が呼ばれていない');
  assert.equal(headTreeCall.agentType, 'dev-flow:dev-runner-haiku-ro', `(f) head-tree-oid の agentType が期待と不一致: ${headTreeCall.agentType}`);
  assert.ok(
    headTreeCall.prompt.includes(`git -C /tmp/wt rev-parse ${HEAD_REF_OID}^{tree}`),
    `(f) head-tree-oid の prompt に git rev-parse コマンドが含まれていない:\n${headTreeCall.prompt}`,
  );

  const ghPrViewCall = calls.find((c) => c.label === 'gh-pr-view');
  assert.ok(ghPrViewCall != null, '(f) gh-pr-view が呼ばれていない');
  assert.ok(
    ghPrViewCall.prompt.includes('--json mergeable,mergeStateStatus,headRefOid'),
    `(f) gh-pr-view の prompt に headRefOid 込みの --json が含まれていない:\n${ghPrViewCall.prompt}`,
  );
});

// ============================================================
// (g) hash 不一致なし → probe 0 回・eval_staleness=none
// ============================================================

test('[hash-reconverged] (g) diff-hash-pr が diff-hash-eval と一致 → tree-diff-numstat/head-tree-oid とも 0 回、eval_staleness=none', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'diff-hash-pr': { hash: 'AAA', empty: false } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'g');
  assert.ok(result !== null, '(g) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'none', `(g) eval_staleness は none のはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(calls.filter((c) => c.label === 'tree-diff-numstat').length, 0, '(g) hash 一致時は tree-diff-numstat が呼ばれてはならない');
  assert.equal(calls.filter((c) => c.label === 'head-tree-oid').length, 0, '(g) hash 一致時は head-tree-oid が呼ばれてはならない');
});

// ============================================================
// (h) fixes_applied>0 でも 3 条件成立なら hash_reconverged
// ============================================================

test('[hash-reconverged] (h) fixes_applied>0 でも 3 条件成立なら eval_staleness=hash_reconverged（merge_tier は assert しない）', async () => {
  const { ctx } = makeSandbox({
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h');
  assert.ok(result !== null, '(h) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_reconverged', `(h) eval_staleness は hash_reconverged のはずだが ${JSON.stringify(result?.eval_staleness)}`);
});
