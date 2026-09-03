// _lib/analyze-comments-routing.test.mjs
// issue #573: dev-flow.js の Analyze phase が issue の comments を要件入力に含め、
// body/comment の矛盾（comment_conflicts）を fail-closed で needs_clarification に
// 落とす配線を VM sandbox で検証する。source pin (a)-(d) と routing T1-T4。
// PR #578: sonnet analyze 経路が comments 取得を落としても検知できない問題を、
// issue-meta probe の comment_count 実測と REQ.comment_count（skill 出力 verbatim）の
// 決定論突合で塞ぐ配線を source pin (e)-(g) と routing T5-T6 で検証する。
//
// テストケース:
//   (a)-(d): source-as-string pin（contractProbePrompt の --json / analyzePrompt の規約文言 /
//            REQ schema のキー追加 / ac_heading_near_miss の可視化）
//   T1: comment_conflicts 非空 → needs_clarification かつ implementer 0 件
//   T2: comment_overrides のみ非空（comment_conflicts 空） → implementer 呼び出し >= 1
//   T3: 両キーとも無い（既存 FULL_REQ 相当） → implementer 呼び出し >= 1（既存挙動不変）
//   T4: comment_conflicts が空白のみの要素 → implementer 呼び出し >= 1（空文字は矛盾扱いしない）
//   (e)-(g): source-as-string pin（issue-meta probe の gh --json に comments が追加 /
//            ISSUE_META・REQ 両 schema に comment_count が追加）
//   T5: issueMetaRes.comment_count と req.comment_count が不一致 → needs_clarification
//       かつ implementer 0 件（comments 取得漏れの検出。PR #578）
//   T6: issueMetaRes.comment_count と req.comment_count が一致 → implementer 呼び出し >= 1
//       （既存挙動不変）

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
// source-as-string pin (a)-(d)
// ============================================================

test('[analyze-comments-routing] (a) contractProbePrompt の gh --json に comments が追加されている', () => {
  assert.ok(
    src.includes('--json body,title,labels,assignees,milestone,state,comments'),
    'contractProbePrompt の gh issue view --json フィールドに comments が含まれていない',
  );
});

test('[analyze-comments-routing] (b) analyzePrompt に comments 読み取りと comment_overrides / comment_conflicts 返却規約がある', () => {
  const m = src.match(/const analyzePrompt = \(depth\) => `[\s\S]*?\n\nconst /);
  assert.ok(m, 'analyzePrompt 定義ブロックが見つからない');
  const block = m[0];
  assert.ok(block.includes('comments'), 'analyzePrompt に comments への言及がない');
  assert.ok(block.includes('comment_overrides'), 'analyzePrompt に comment_overrides への言及がない');
  assert.ok(block.includes('comment_conflicts'), 'analyzePrompt に comment_conflicts への言及がない');
});

test('[analyze-comments-routing] (c) REQ schema に comment_overrides / comment_conflicts が追加されている', () => {
  const m = src.match(/const REQ = \{[\s\S]*?\n\}/);
  assert.ok(m, 'REQ schema 定義が見つからない');
  const block = m[0];
  assert.ok(block.includes('comment_overrides'), 'REQ schema に comment_overrides が無い');
  assert.ok(block.includes('comment_conflicts'), 'REQ schema に comment_conflicts が無い');
});

test('[analyze-comments-routing] (d) ac_heading_near_miss が dev-flow.js に含まれる（fallback 時の警告 log 可視化）', () => {
  assert.ok(src.includes('ac_heading_near_miss'), 'dev-flow.js に ac_heading_near_miss への言及がない');
});

test('[analyze-comments-routing] (e) issue-meta probe の gh --json に comments が追加されている', () => {
  assert.ok(
    src.includes('--json number,title,comments'),
    'issue-meta probe の gh issue view --json フィールドに comments が含まれていない',
  );
});

test('[analyze-comments-routing] (f) ISSUE_META schema に comment_count が追加されている', () => {
  const m = src.match(/const ISSUE_META = \{[\s\S]*?\n\}/);
  assert.ok(m, 'ISSUE_META schema 定義が見つからない');
  assert.ok(m[0].includes('comment_count'), 'ISSUE_META schema に comment_count が無い');
});

test('[analyze-comments-routing] (g) REQ schema に comment_count が追加されている', () => {
  const m = src.match(/const REQ = \{[\s\S]*?\n\}/);
  assert.ok(m, 'REQ schema 定義が見つからない');
  assert.ok(m[0].includes('comment_count'), 'REQ schema に comment_count が無い');
});

// ============================================================
// routing T1-T4（VM sandbox）
// ============================================================

const FULL_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  breaking_change: false,
  breaking_keyword_scan: false,
  ambiguities: [],
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function createResponder({ req = FULL_REQ, issueMetaRes = { ok: true, number: 1, title: 'stub-issue-title' } } = {}) {
  return function ({ label, agentType }) {
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label === 'issue-meta') return issueMetaRes;
    if (label.startsWith('contract-probe')) return null; // fail-open（whitelist 不合格扱い）— sonnet fallback
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

test('[analyze-comments-routing] T1: comment_conflicts 非空 → needs_clarification かつ implementer 0 件', async () => {
  const conflicts = ['body: 絶対パス 15 箇所 → comment: 30 箇所（alice, 2026-01-01）'];
  const req = { ...FULL_REQ, comment_conflicts: conflicts };
  const { ctx, calls } = makeSandbox({ req });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T1');
  assert.equal(error, null, `T1: run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `T1: status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(result?.source, 'analyze', `T1: source は analyze のはずだが ${JSON.stringify(result?.source)}`);
  assert.deepEqual(result?.missing_context, conflicts, `T1: missing_context が comment_conflicts と一致しない: ${JSON.stringify(result?.missing_context)}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.equal(implCalls.length, 0, `T1: implementer 呼び出しは 0 件のはずだが ${implCalls.length} 件`);
  assert.equal(error, null);
});

test('[analyze-comments-routing] T2: comment_overrides のみ非空 → implementer 呼び出し >= 1（run は進む）', async () => {
  const req = { ...FULL_REQ, comment_overrides: ['body: 1 plugin → comment: 3 plugin（alice, 2026-01-01）'], comment_conflicts: [] };
  const { ctx, calls } = makeSandbox({ req });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T2');
  assert.equal(error, null, `T2: run が throw してはならないが: ${error?.message}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, `T2: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
});

test('[analyze-comments-routing] T3: 両キーとも無い（既存 FULL_REQ 相当）→ implementer 呼び出し >= 1（既存挙動不変）', async () => {
  const { ctx, calls } = makeSandbox({ req: FULL_REQ });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T3');
  assert.equal(error, null, `T3: run が throw してはならないが: ${error?.message}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, `T3: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
});

test('[analyze-comments-routing] T4: comment_conflicts が空白のみの要素 → implementer 呼び出し >= 1（空文字は矛盾として扱わない）', async () => {
  const req = { ...FULL_REQ, comment_conflicts: ['', '   '] };
  const { ctx, calls } = makeSandbox({ req });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T4');
  assert.equal(error, null, `T4: run が throw してはならないが: ${error?.message}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, `T4: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
});

test('[analyze-comments-routing] T5: req.comment_count と issueMetaRes.comment_count が不一致 → needs_clarification かつ implementer 0 件（PR #578: comments 取得漏れの検出）', async () => {
  const req = { ...FULL_REQ, comment_count: 0 };
  const issueMetaRes = { ok: true, number: 1, title: 'stub-issue-title', comment_count: 3 };
  const { ctx, calls } = makeSandbox({ req, issueMetaRes });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'T5');
  assert.equal(error, null, `T5: run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `T5: status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(result?.source, 'analyze', `T5: source は analyze のはずだが ${JSON.stringify(result?.source)}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.equal(implCalls.length, 0, `T5: implementer 呼び出しは 0 件のはずだが ${implCalls.length} 件`);
});

test('[analyze-comments-routing] T6: req.comment_count と issueMetaRes.comment_count が一致 → implementer 呼び出し >= 1（既存挙動不変）', async () => {
  const req = { ...FULL_REQ, comment_count: 2 };
  const issueMetaRes = { ok: true, number: 1, title: 'stub-issue-title', comment_count: 2 };
  const { ctx, calls } = makeSandbox({ req, issueMetaRes });
  const { error } = await run(ctx);
  assertNoCrash(error, 'T6');
  assert.equal(error, null, `T6: run が throw してはならないが: ${error?.message}`);
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:implementer');
  assert.ok(implCalls.length >= 1, `T6: implementer 呼び出しは 1 件以上のはずだが ${implCalls.length} 件`);
});
