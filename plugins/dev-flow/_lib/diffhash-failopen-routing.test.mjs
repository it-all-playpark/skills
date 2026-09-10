// diffhash-failopen-routing: VM sandbox routing test for dev-flow の diff-hash 3 箇所
// （diff-hash-eval / diff-hash-pr / diff-hash-merge）の fail-open 配線（issue #605）。
//
// 3 箇所とも `trackedAgent` 直呼びから `failOpenAgent`（`retryOnContractViolation: true`）経由へ
// 置換済みで、proxy agent が throw（StructuredOutput 未返却・実行失敗）しても run 全体が abort
// せず、既存の null 経路（stale-eval 検出 skip / danger-grep-final・changed-files 再実行）へ
// 合流して journal handoff まで完走することを実証する。
//
// ハーネスは _lib/merge-tier-diffhash-reuse-routing.test.mjs の createResponder / STANDARD_REQ を
// 踏襲し、_lib/test-helpers/vm-sandbox.mjs の makeRecordingSandbox / runDevFlowInSandbox を使う。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// StructuredOutput 契約違反メッセージ（trackedAgent の retryOnContractViolation 判定文字列を含む）
const CV = 'agent({schema}): subagent completed without calling StructuredOutput';

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 605,
  issue_title: 'stub-issue-title',
};

// ============================================================
// responder factory: merge-tier-diffhash-reuse-routing.test.mjs の createResponder を複製
// （danger-grep の diffhash が既定で SAMEHASH を返す — state.secDiffHash が non-null になり
// diff-hash-merge が呼ばれる条件を満たす）。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-605' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'SAMEHASH', empty: false } };
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
    if (label === 'diff-hash-merge') return { hash: 'SAMEHASH', empty: false };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true };
    if (agentType === 'dev-flow:implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 605, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {} } = {}) {
  const logs = [];
  const { ctx, calls } = makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 0 }),
    args: '605',
    log: (m) => logs.push(String(m)),
  });
  return { ctx, calls, logs };
}

// ============================================================
// (a) diff-hash-eval が契約違反で throw → 継続 + リトライ2回 + 警告ログ + Evaluate/handoff 到達
// ============================================================

test('[diffhash-failopen] (a) diff-hash-eval が契約違反で throw → run 完走・2 回呼ばれ吸収・警告 log・Evaluate/journal-save 到達', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'diff-hash-eval': () => { throw new Error(CV) },
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'a');
  assert.equal(err, null, `(a) run は abort せず完走するはずだが error: ${err?.name}: ${err?.message}`);

  const dhEvalCalls = calls.filter((c) => c.label === 'diff-hash-eval');
  assert.equal(dhEvalCalls.length, 2, `(a) 契約違反リトライで diff-hash-eval は 2 回呼ばれるはずだが ${dhEvalCalls.length} 回`);

  assert.ok(logs.some((l) => l.includes('diff-hash-eval') && l.includes('fail-open')), '(a) diff-hash-eval の fail-open 警告 log が無い');
  assert.ok(logs.some((l) => l.includes('stale-eval 検出は skip')), '(a) stale-eval skip の警告 log が無い');

  assert.ok(calls.some((c) => c.agentType === 'dev-flow:evaluator'), '(a) Evaluate phase（evaluator 呼び出し）へ継続しているはず');
  assert.ok(calls.some((c) => c.label === 'journal-save'), '(a) journal-save まで到達しているはず（handoff 到達）');
});

// ============================================================
// (b) diff-hash-pr が契約違反以外の理由で throw → リトライなし 1 回のみ + 継続
// ============================================================

test('[diffhash-failopen] (b) diff-hash-pr が非契約違反エラーで throw → run 完走・1 回のみ呼ばれ吸収・警告 log・journal-save 到達', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'diff-hash-pr': () => { throw new Error('EPERM: operation not permitted') },
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'b');
  assert.equal(err, null, `(b) run は abort せず完走するはずだが error: ${err?.name}: ${err?.message}`);

  const dhPrCalls = calls.filter((c) => c.label === 'diff-hash-pr');
  assert.equal(dhPrCalls.length, 1, `(b) 契約違反以外はリトライしないため diff-hash-pr は 1 回のみ呼ばれるはずだが ${dhPrCalls.length} 回`);

  assert.ok(logs.some((l) => l.includes('diff-hash-pr の取得に失敗 — stale-eval 検出は skip')), '(b) diff-hash-pr の fail-open 警告 log が無い');
  assert.ok(calls.some((c) => c.label === 'journal-save'), '(b) journal-save まで到達しているはず（handoff 到達）');
});

// ============================================================
// (c) diff-hash-merge が契約違反で throw → 継続 + リトライ2回 + danger-grep-final 再実行 + handoff 到達
// ============================================================

test('[diffhash-failopen] (c) diff-hash-merge が契約違反で throw → run 完走・2 回呼ばれ吸収・danger-grep-final 再実行・journal-save 到達', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'diff-hash-merge': () => { throw new Error(CV) },
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'c');
  assert.equal(err, null, `(c) run は abort せず完走するはずだが error: ${err?.name}: ${err?.message}`);

  const dhMergeCalls = calls.filter((c) => c.label === 'diff-hash-merge');
  assert.equal(dhMergeCalls.length, 2, `(c) 契約違反リトライで diff-hash-merge は 2 回呼ばれるはずだが ${dhMergeCalls.length} 回`);

  assert.ok(calls.some((c) => c.label === 'danger-grep-final'), '(c) diff-hash-merge 取得失敗時は danger-grep-final が再実行される（reuse skip、fail-safe）はず');
  assert.ok(logs.some((l) => l.includes('diff-hash-merge') && l.includes('fail-open')), '(c) diff-hash-merge の fail-open 警告 log が無い');
  assert.ok(calls.some((c) => c.label === 'journal-save'), '(c) journal-save まで到達しているはず（handoff 到達）');
});

// ============================================================
// (d) source pin: 3 箇所とも failOpenAgent + retryOnContractViolation: true、trackedAgent(state.dhPrompt は 0 件
// ============================================================

test('[diffhash-failopen] (d) source pin: diff-hash 3 箇所が failOpenAgent(state.dhPrompt, {..., retryOnContractViolation: true) で、trackedAgent(state.dhPrompt は残存しない', () => {
  const re = /failOpenAgent\(state\.dhPrompt,\s*\{[^}]*label: '(diff-hash-eval|diff-hash-pr|diff-hash-merge)'[^}]*retryOnContractViolation: true/g;
  const matches = [...devFlowSrc.matchAll(re)];
  assert.equal(matches.length, 3, `(d) failOpenAgent(state.dhPrompt, ...retryOnContractViolation: true) の出現は 3 件のはずだが ${matches.length} 件`);

  const labels = new Set(matches.map((m) => m[1]));
  assert.deepEqual(labels, new Set(['diff-hash-eval', 'diff-hash-pr', 'diff-hash-merge']), `(d) label 集合が期待と不一致: ${JSON.stringify([...labels])}`);

  const bareCount = (devFlowSrc.match(/trackedAgent\(state\.dhPrompt/g) || []).length;
  assert.equal(bareCount, 0, `(d) trackedAgent(state.dhPrompt の裸呼び出しが残存している（${bareCount} 件）`);
});

// ============================================================
// (e) 対照: override なし（全 diff-hash が hash を返す）→ 正常完走・stale-eval skip ログ無し
// ============================================================

test('[diffhash-failopen] (e) 対照: diff-hash 全て正常応答 → run 完走・stale-eval skip 警告なし', async () => {
  const { ctx, calls, logs } = makeSandbox();
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'e');
  assert.equal(err, null, `(e) run は完走するはずだが error: ${err?.name}: ${err?.message}`);

  assert.ok(!logs.some((l) => l.includes('stale-eval 検出は skip')), '(e) 正常応答時は stale-eval skip 警告が出ないはず');
  assert.ok(calls.some((c) => c.label === 'journal-save'), '(e) journal-save まで到達しているはず（handoff 到達）');
});
