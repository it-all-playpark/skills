// _lib/analyze-contract-routing.test.mjs
// Guard test: Analyze phase の決定論 parse 降格経路 (contract probe → buildReqFromContract →
// fail-open fallback) の配線 pin（issue #374 task F2）。
//
// issue #636 P3a: 旧版は dev-flow.js ソース文字列に対する readFileSync + regex/includes pin だった。
// 本版は VM sandbox で agent() を mock し、実際に渡される contract-probe#1 / analyze#1 の
// label・agentType・prompt トークン・fail-open 挙動・needs_clarification routing を検証する。
//
// probe label は 'contract-probe#' + ISSUE（'analyze-contract#' ではない）: 既存の
// *-routing.test.mjs 群が label.startsWith('analyze') で sonnet analyze 呼び出しを識別しているため、
// 'analyze' prefix と衝突する label にすると既存テストの呼び出し回数・挙動を壊してしまう。
// 'contract-probe#' なら既存 responder のどの分岐にもマッチせず null を返す → fail-open ロジックが
// そのまま現行 analyze# fallback に委譲する。
//
// Run: npx vitest run _lib/analyze-contract-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

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

function baseResponder({ req = FULL_REQ, contractHandler } = {}) {
  return function ({ label, agentType }) {
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    if (label.startsWith('contract-probe')) {
      if (contractHandler) return contractHandler({ label, agentType });
      return null; // fail-open（whitelist 不合格扱い）— sonnet fallback
    }
    if (label.startsWith('analyze')) return req;
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
    if (agentType === 'dev-flow:dev-implement-fable') return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
    return null;
  };
}

function makeSandbox(opts = {}, extra = {}) {
  return makeRecordingSandbox(baseResponder(opts), { args: devFlowArgs('1'), ...extra });
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

// ---- (a) label 'contract-probe#1' と agentType 'dev-runner-haiku-ro'（namespaced: dev-flow:dev-runner-haiku-ro）----
// contract probe は read-only 決定論 proxy（Write/Edit 禁止を prompt 自身が宣言）のため、
// AGENTS.md の exec-proxy 分離規約に従い dev-runner-haiku-ro（tools: [Bash, Read] のみ）を使用する
// （PR #388 review, major #2）。
test("[analyze-contract-routing] (a) contract-probe#1 が agentType 'dev-flow:dev-runner-haiku-ro' で呼ばれる", async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await run(ctx);
  assertNoCrash(error, 'a');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.ok(
    calls.some((c) => c.label === 'contract-probe#1' && c.agentType === 'dev-flow:dev-runner-haiku-ro'),
    "contract-probe#1 呼び出しが agentType 'dev-flow:dev-runner-haiku-ro' で見つからない",
  );
});

// ---- (b) contract-probe は fail-open（throw しても run は abort せず analyze# fallback へ進む）----
test('[analyze-contract-routing] (b) contract-probe#1 が throw しても run は abort せず analyze#1 へ fallback する（fail-open）', async () => {
  const { ctx, calls } = makeSandbox({ contractHandler: () => { throw new Error('boom'); } });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'b');
  assert.equal(error, null, `contract-probe#1 の throw で run 全体が abort してはならないが: ${error?.message}`);
  assert.ok(calls.some((c) => c.label === 'analyze#1'), 'analyze#1 へのフォールバック呼び出しが観測できない');
  assert.equal(typeof result, 'object', 'run の結果は object のはず');
  assert.ok(result !== null, 'run の結果は null であってはならない');
});

// ---- (c) fallback の analyze#1 は agentType 'dev-flow:dev-runner'。needs_clarification 判定で
//          中断した場合 plan#1 は呼ばれない ----
test("[analyze-contract-routing] (c) fallback の analyze#1 は agentType 'dev-flow:dev-runner' で呼ばれる", async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await run(ctx);
  assertNoCrash(error, 'c-1');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.ok(
    calls.some((c) => c.label === 'analyze#1' && c.agentType === 'dev-flow:dev-runner'),
    "analyze#1 呼び出しが agentType 'dev-flow:dev-runner' で見つからない",
  );
});

test('[analyze-contract-routing] (c) analyze#1 が要件曖昧（ambiguities 超過）を返すと needs_clarification で中断し plan#1 は呼ばれない', async () => {
  const req = { ...FULL_REQ, ambiguities: ['a', 'b', 'c'] };
  const { ctx, calls } = makeSandbox({ req });
  const { result, error } = await run(ctx);
  assertNoCrash(error, 'c-2');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification', `status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.ok(!calls.some((c) => c.label === 'plan#1'), 'needs_clarification で中断した場合 plan#1 は呼ばれてはならない');
});

// ---- (d) DEPTH === 'standard' ガード: DEPTH がそれ以外なら contract-probe は 0 回 ----
test("[analyze-contract-routing] (d) DEPTH !== 'standard' のとき contract-probe は呼ばれない", async () => {
  const { ctx, calls } = makeSandbox({}, { args: { ...devFlowArgs('1'), depth: 'light' } });
  const { error } = await run(ctx);
  assertNoCrash(error, 'd');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  const contractCalls = calls.filter((c) => c.label.startsWith('contract-probe'));
  assert.equal(contractCalls.length, 0, `DEPTH!=='standard' のとき contract-probe は 0 回のはずだが ${contractCalls.length} 件`);
});

// ---- (e) script 呼び出しが plugin bin/ の bare 名先頭トークン形（cd 前置・bash 前置なし）である ----
// issue #466: analyze-issue.sh は --issue-json ファイル入力の純変換へ改修されたため、
// contract probe は事前に bare `gh issue view` で issue JSON を $TMPDIR file へ取得してから
// script を --issue-json 付きで呼ぶ 2 段階 choreography になった。
test('[analyze-contract-routing] (e) contract-probe#1 prompt が bare 名先頭トークン形の analyze-issue 呼び出しを含む', async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await run(ctx);
  assertNoCrash(error, 'e-1');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  const call = calls.find((c) => c.label === 'contract-probe#1');
  assert.ok(call, 'contract-probe#1 呼び出しが見つからない');
  assert.ok(
    call.prompt.includes('analyze-issue 1 --issue-json <ISSUE_JSON> --contract'),
    `bare 名先頭トークン形の analyze-issue 呼び出しが見つからない: ${call.prompt}`,
  );
  assert.ok(!/\bbash analyze-issue/.test(call.prompt), "'bash analyze-issue' 前置形が含まれてはならない");
  // 注: contractProbePrompt は cd 前置禁止を指示する自然文（「cd 前置」「cd X && script」等）を
  // 含むため、'cd ' の単純な非包含チェックは成立しない（instructional text 自体が cd を語る）。
  // 実質的なチェックは上の bare 名先頭トークン形の positive pin と bash 前置の negative pin で足りる。
  assert.ok(!/^cd /m.test(call.prompt), '実行コマンド行が cd で始まってはならない（各行頭が cd で始まらないことを確認）');
});

test('[analyze-contract-routing] (e) contract-probe#1 prompt が bare `gh issue view` で issue JSON を先行取得する', async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await run(ctx);
  assertNoCrash(error, 'e-2');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  const call = calls.find((c) => c.label === 'contract-probe#1');
  assert.ok(call, 'contract-probe#1 呼び出しが見つからない');
  assert.ok(call.prompt.includes('gh issue view 1'), `bare 'gh issue view 1' 実行指示が見つからない: ${call.prompt}`);
});

// ---- (f) 分類器 trigger 文言（sandbox/excludedCommands 起動理由の説明）を含まない ----
// issue #466 AC-1: prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない
// （分類器 trigger）。
test("[analyze-contract-routing] (f) contract-probe#1 prompt が 'sandbox'/'excludedCommands' を含まない", async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await run(ctx);
  assertNoCrash(error, 'f');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  const call = calls.find((c) => c.label === 'contract-probe#1');
  assert.ok(call, 'contract-probe#1 呼び出しが見つからない');
  assert.ok(!/sandbox/.test(call.prompt), `contract-probe#1 prompt に 'sandbox' が含まれてはならない。prompt: ${call.prompt}`);
  assert.ok(!/excludedCommands/.test(call.prompt), `contract-probe#1 prompt に 'excludedCommands' が含まれてはならない。prompt: ${call.prompt}`);
});
