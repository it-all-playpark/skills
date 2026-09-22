// _lib/analyze-prompt-calibration.test.mjs
// issue #636 P3a: analyzePrompt / STAGING_CONVENTION の配線検証を、dev-flow.js ソース文字列への
// readFileSync + includes pin（旧版）から、VM sandbox で agent() を mock し実際に渡された
// analyze#1 / impl:serial:issue-1 prompt に対するトークン pin・否定側 pin へ書き換えたもの
// （issue #272 / #278 の意図はそのまま維持: bias 撤去・shape 境界一致・breaking 構造化判定の配線）。
//
// analyze stub は事前 shape 見積もりを返さない（issue #676: analyzePrompt から shape / estimated_change_file_count の
// 指示を撤去し、実効 shape は Security floor で realized diff から決める）。danger-grep stub が旧形（files 無し）を
// 返すため realized count 欠損 → complex（Evaluate まで到達する経路の前提）。
// Plan phase は無く、全 shape で合成 plan のみ（issue #673 / #678）— 実装 prompt は impl:serial:issue-1 で観測する。
import { test, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

const REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'feat',
  scope: 'src',
  scope_truncated: false,
  breaking_change: false,
  breaking_keyword_scan: false,
  breaking_evidence: '',
  ambiguities: [],
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function createResponder() {
  return function ({ label, agentType }) {
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    if (label.startsWith('contract-probe')) return null; // fail-open → sonnet fallback（analyze#1）
    if (label.startsWith('analyze')) return REQ;
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
        ac_results: REQ.acceptance_criteria.map((_, i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (label === 'journal-log-failure') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implement-fable') return { status: 'DONE', task_id: 'issue-1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
    return null;
  };
}

let calls;
let runError;
let analyzeCall;
let implCall;

beforeAll(async () => {
  const sandbox = makeRecordingSandbox(createResponder(), { args: devFlowArgs('1') });
  runError = await runDevFlowInSandbox(src, sandbox.ctx);
  calls = sandbox.calls;
  analyzeCall = calls.find((c) => c.label === 'analyze#1');
  implCall = calls.find((c) => c.label === 'impl:serial:issue-1');
});

test('run: dev-flow.js が sandbox で throw しない', () => {
  assert.equal(runError, null, `run が throw してはならないが: ${runError?.message}`);
});

test("run: analyze#1 と impl:serial:issue-1 の呼び出しが両方観測できる（shape=complex 経路の前提）", () => {
  assert.ok(analyzeCall, 'analyze#1 呼び出しが見つからない');
  assert.ok(implCall, "impl:serial:issue-1 呼び出しが見つからない（合成 plan の dev-implement-fable spawn）");
});

// (a) 旧 bias 文言が analyze#1 prompt に含まれない（否定側 pin。issue #272）
test('analyze#1 prompt: 「安全側=complex 寄り」を含まない', () => {
  assert.ok(!analyzeCall.prompt.includes('安全側=complex 寄り'));
});

test('analyze#1 prompt: 「単一ファイル軽微変更」を含まない', () => {
  assert.ok(!analyzeCall.prompt.includes('単一ファイル軽微変更'));
});

// (a2) 事前 shape 見積もりの指示が analyze#1 prompt に無い（issue #676: 実効 shape は realized diff から決める。
// LLM に shape / 見込み file 数を返させない）。identifier token pin。
test('analyze#1 prompt: estimated_change_file_count / shape 見積もりの指示を含まない', () => {
  assert.ok(!analyzeCall.prompt.includes('estimated_change_file_count'));
  assert.ok(!analyzeCall.prompt.includes('shape として返せ'));
  assert.ok(!/micro \/ standard \/ complex のいずれかで評価/.test(analyzeCall.prompt));
});

// (b) breaking 判定は構造化フィールド（breaking_keyword_scan / breaking_evidence）を通す配線に
// なっている（issue #278）。identifier token pin — 文言そのものは pin しない。
test('analyze#1 prompt: breaking_keyword_scan フィールドへの言及がある', () => {
  assert.ok(analyzeCall.prompt.includes('breaking_keyword_scan'));
});

test('analyze#1 prompt: breaking_evidence フィールドへの言及がある', () => {
  assert.ok(analyzeCall.prompt.includes('breaking_evidence'));
});

// (c) STAGING_CONVENTION が実装 spawn prompt へ注入されている（一時ファイル配置規約のパス token）
test("impl:serial:issue-1 prompt: STAGING_CONVENTION 注入（'.devflow-tmp/' パス token）が含まれる", () => {
  assert.ok(implCall.prompt.includes('.devflow-tmp/'));
});

// (d) isBreakingText（旧 LLM 自由文 regex 実装）への参照が analyze#1 / impl:serial:issue-1 のいずれの prompt にも
// 残っていない（issue #278 の置換が完了していることの確認）
test('analyze#1 prompt: isBreakingText への参照が無い', () => {
  assert.ok(!analyzeCall.prompt.includes('isBreakingText'));
});

test('impl:serial:issue-1 prompt: isBreakingText への参照が無い', () => {
  assert.ok(!implCall.prompt.includes('isBreakingText'));
});
