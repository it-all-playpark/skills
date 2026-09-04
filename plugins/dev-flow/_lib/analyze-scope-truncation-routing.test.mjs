// _lib/analyze-scope-truncation-routing.test.mjs
// issue #596: dev-flow workflow 側で「scope 切断」を analyze subagent と人間の両方へ伝搬させる配線を
// VM sandbox で検証する。source pin (a)-(c) と routing T1-T5。
//
// テストケース:
//   (a)-(c): source-as-string pin（REQ schema の scope_truncated / analyzePrompt の切断規約文言 /
//            buildReqFromContract inline 区間の scope_truncated 厳格チェック）
//   T1: scope_truncated:true + ambiguities 超過 → needs_clarification かつ missing_context 先頭に
//       切断ヒント、implementer 呼び出し 0 件
//   T2: scope_truncated:false + ambiguities 超過 → needs_clarification（既存挙動不変、ヒント無し）
//   T3: scope_truncated:true + ambiguities 空 → implementer 呼び出し >= 1（切断だけでは中断しない）
//   T4: contract 経路採用（scope_truncated:true が verbatim で採用） → analyze# label 呼び出し 0 件、
//       implementer >= 1、dev-planner prompt に [TRUNCATED: scope shows が含まれる
//   T5: contract 経路で scope_truncated 欠落 → whitelist 不合格で sonnet fallback（analyze# 呼び出し 1 回以上）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// source-as-string pin (a)-(c)
// ============================================================

test('[analyze-scope-truncation-routing] (a) REQ schema に scope_truncated (boolean) が追加されている', () => {
  const m = src.match(/const REQ = \{[\s\S]*?\n\}/);
  assert.ok(m, 'REQ schema 定義が見つからない');
  assert.ok(m[0].includes("scope_truncated: { type: 'boolean' }"), 'REQ schema に scope_truncated: { type: \'boolean\' } が無い');
});

test('[analyze-scope-truncation-routing] (b) analyzePrompt に scope 切断時の全文読み取り規約・ambiguities 禁止・マーカー言及がある', () => {
  const m = src.match(/const analyzePrompt = \(depth\) => `[\s\S]*?\n\nconst /);
  assert.ok(m, 'analyzePrompt 定義ブロックが見つからない');
  const block = m[0];
  assert.ok(block.includes('scope_truncated'), 'analyzePrompt に scope_truncated への言及がない');
  assert.ok(block.includes('抜粋に無いことを根拠に ambiguities を立ててはならない'), 'analyzePrompt に ambiguities 禁止規約が無い');
  assert.ok(block.includes('[TRUNCATED:'), 'analyzePrompt に [TRUNCATED: マーカーへの言及がない');
});

test('[analyze-scope-truncation-routing] (c) buildReqFromContract inline 区間に scope_truncated の厳格 boolean チェックがある', () => {
  const beginMarker = '// ==== BEGIN inline: _lib/analyze-contract.mjs';
  const endMarker = '// ==== END inline: _lib/analyze-contract.mjs ====';
  const beginIdx = src.indexOf(beginMarker);
  const endIdx = src.indexOf(endMarker);
  assert.ok(beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx, 'analyze-contract.mjs の inline 区間が見つからない');
  const block = src.slice(beginIdx, endIdx);
  assert.ok(block.includes("typeof contract.scope_truncated !== 'boolean'"), 'inline 区間に scope_truncated の厳格 boolean チェックが無い');
});

// ============================================================
// routing T1-T5（VM sandbox）
// ============================================================

const FULL_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  scope_truncated: false,
  estimated_change_file_count: 3,
  shape: 'standard',
  breaking_change: false,
  breaking_keyword_scan: false,
  ambiguities: [],
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function createResponder({ req = FULL_REQ, issueMetaRes = { ok: true, number: 1, title: 'stub-issue-title' }, contractProbeRes = null } = {}) {
  return function ({ label, agentType, prompt }) {
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label === 'issue-meta') return issueMetaRes;
    if (label.startsWith('contract-probe')) return contractProbeRes === null ? null : { ok: true, result: contractProbeRes };
    if (label.startsWith('analyze')) return req;
    if (agentType === 'dev-flow:dev-planner') return { summary: 'p', serial: [{ id: 'T1', desc: 't1', file_changes: ['src/a.ts'] }], parallel: [] };
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/a.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/a.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: (req.acceptance_criteria ?? []).map((_, i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (label === 'journal-log-failure') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:implementer') return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
    return null;
  };
}

function makeSandbox(opts) {
  const { ctx, calls } = makeRecordingSandbox(createResponder(opts), { args: '1' });
  return { ctx, calls };
}

async function run(ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;
  const vm = await import('node:vm');
  let caughtError = null;
  let resolvedResult = null;
  try {
    const promise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (promise && typeof promise.then === 'function') {
      resolvedResult = await promise.catch((e) => { caughtError = e; return null; });
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

test('[analyze-scope-truncation-routing] T1: scope_truncated:true + ambiguities 超過 → needs_clarification かつ missing_context 先頭に切断ヒント、implementer 0 件', async () => {
  const req = { ...FULL_REQ, scope_truncated: true, scope_total_chars: 5120, ambiguities: ['a', 'b', 'c'] };
  const { ctx, calls } = makeSandbox({ req });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T1');
  assert.equal(error, null, `T1: run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `T1: status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(result?.source, 'analyze', `T1: source は analyze のはずだが ${JSON.stringify(result?.source)}`);
  assert.equal(result?.missing_context?.length, 4, `T1: missing_context は 4 件のはずだが ${JSON.stringify(result?.missing_context)}`);
  assert.ok(result.missing_context[0].includes('scope が切断'), `T1: missing_context[0] に "scope が切断" が含まれない: ${result.missing_context[0]}`);
  assert.ok(result.missing_context[0].includes('5120'), `T1: missing_context[0] に総文字数 5120 が含まれない: ${result.missing_context[0]}`);
  // JSON round-trip: VM sandbox 内で構成された配列は host realm の Array.prototype と異なる
  // ため assert.deepEqual の prototype 比較で誤って不一致になる（値は一致）。プリミティブ値の
  // 構造比較に限定するため一度 JSON を経由する。
  assert.deepEqual(JSON.parse(JSON.stringify(result.missing_context.slice(1))), ['a', 'b', 'c'], `T1: missing_context の残りが ambiguities と一致しない: ${JSON.stringify(result.missing_context)}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.equal(implCalls.length, 0, `T1: implementer 呼び出しは 0 件のはずだが ${implCalls.length} 件`);
});

test('[analyze-scope-truncation-routing] T2: scope_truncated:false + ambiguities 超過 → needs_clarification（既存挙動不変、ヒント無し）', async () => {
  const req = { ...FULL_REQ, scope_truncated: false, ambiguities: ['a', 'b', 'c'] };
  const { ctx, calls } = makeSandbox({ req });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T2');
  assert.equal(error, null, `T2: run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `T2: status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.deepEqual(result?.missing_context, ['a', 'b', 'c'], `T2: missing_context が ambiguities と一致しない: ${JSON.stringify(result?.missing_context)}`);
});

test('[analyze-scope-truncation-routing] T3: scope_truncated:true + ambiguities 空 → implementer 呼び出し >= 1（切断だけでは中断しない）', async () => {
  const req = { ...FULL_REQ, scope_truncated: true, ambiguities: [] };
  const { ctx, calls } = makeSandbox({ req });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T3');
  assert.equal(error, null, `T3: run が throw してはならないが: ${error?.message}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, `T3: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
});

test('[analyze-scope-truncation-routing] T4: contract 経路採用（scope_truncated:true 検証済み） → analyze# 呼び出し 0 件、implementer >= 1、dev-planner prompt に [TRUNCATED: scope shows が含まれる', async () => {
  const contractProbeRes = {
    contract: 't1', eligible: true, issue_number: 1, title: 'stub-issue-title', issue_type: 'feat',
    acceptance_criteria: ['a', 'b', 'c'],
    scope: 'x\n[TRUNCATED: scope shows the first 4000 of 5000 chars of the issue body (AC section excluded); the remainder was NOT included. Do not treat anything absent from this excerpt as unspecified — read the full body from the fetched issue JSON before raising ambiguities]',
    scope_truncated: true,
    scope_total_chars: 5000,
    breaking_keyword_scan: false,
    comment_count: 0,
    ac_heading_near_miss: [],
    estimated_change_file_count: 3,
  };
  const { ctx, calls } = makeSandbox({ contractProbeRes });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T4');
  assert.equal(error, null, `T4: run が throw してはならないが: ${error?.message}`);
  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze#'));
  assert.equal(analyzeCalls.length, 0, `T4: analyze# label 呼び出しは 0 件のはずだが ${analyzeCalls.length} 件`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, `T4: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-flow:dev-planner');
  assert.ok(plannerCalls.length >= 1, 'T4: dev-planner 呼び出しが見つからない');
  assert.ok(
    plannerCalls.some((c) => c.prompt.includes('[TRUNCATED: scope shows')),
    'T4: dev-planner への prompt に切断マーカーが含まれていない',
  );
});

test('[analyze-scope-truncation-routing] T5: contract 経路で scope_truncated 欠落 → whitelist 不合格で sonnet fallback（analyze# 呼び出し 1 件以上）', async () => {
  const contractProbeRes = {
    contract: 't1', eligible: true, issue_number: 1, title: 'stub-issue-title', issue_type: 'feat',
    acceptance_criteria: ['a', 'b', 'c'],
    scope: 'x',
    breaking_keyword_scan: false,
    comment_count: 0,
    ac_heading_near_miss: [],
    estimated_change_file_count: 3,
  };
  const { ctx, calls } = makeSandbox({ contractProbeRes });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T5');
  assert.equal(error, null, `T5: run が throw してはならないが: ${error?.message}`);
  const analyzeCalls = calls.filter((c) => c.label.startsWith('analyze#'));
  assert.ok(analyzeCalls.length >= 1, `T5: analyze# label 呼び出しは 1 件以上のはずだが ${analyzeCalls.length} 件`);
});
