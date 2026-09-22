// VALIDATE_TEST_PROMPT（Validate phase の test 実行 exec-proxy prompt）を VM run で実際に
// test#1 へ渡る prompt として捕捉し、argv/token/データ echo/否定側で検証する（issue #636 P3b）。
//
// 旧版は dev-flow.js の VALIDATE_TEST_PROMPT 定義ブロックを readFileSync + slice して日本語の
// 指示文・規約文を部分一致で pin していたが、言い回し変更のみで落ちる pin だったため置換した。
// tests:'error' / tests:'failed' で green-fix ルーティングが分岐する挙動は
// _lib/validate-tests-error-skip-routing.test.mjs が既に VM sandbox で担っているため、
// 本ファイルでは重複させない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

function responder({ label, agentType }) {
  if (label === 'setup-base') {
    return {
      ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
      worktree_exists: false, upstream_remote: '', upstream_merge: '',
    };
  }
  if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-553' };
  if (label.startsWith('analyze')) {
    return {
      summary: 's',
      acceptance_criteria: ['a', 'b'],
      issue_type: 'fix',
      scope: 'src',
      issue_number: 553,
      issue_title: 'stub-issue-title',
    };
  }
  if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
  if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
  if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
  if (agentType === 'dev-flow:dev-implement-fable') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
  if (agentType === 'dev-flow:evaluator') {
    return {
      verdict: 'pass', total: 100, threshold: 80, feedback: [],
      feedback_level: 'implementation', ac_results: [], security_clearance: [],
    };
  }
  if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') return { files: [] };
  if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
  if (label === 'issue-meta') return { ok: true, number: 553, title: 'stub-issue-title' };
  return null;
}

let sharedCalls = null;
let sharedError = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const { ctx, calls } = makeRecordingSandbox(responder, { args: devFlowArgs('553') });
  const error = await runDevFlowInSandbox(devFlowSrc, ctx);
  sharedCalls = calls;
  sharedError = error;
}

function test1Prompt() {
  const c = sharedCalls.find((x) => x.label === 'test#1');
  assert.ok(
    c != null,
    `label === 'test#1' の call が見つからない (labels: ${sharedCalls.map((x) => x.label).join(', ')})`,
  );
  assert.equal(
    c.agentType,
    'dev-flow:dev-runner-haiku',
    `test#1 の agentType は 'dev-flow:dev-runner-haiku' のはずだが '${c.agentType}' だった`,
  );
  return c.prompt;
}

test('[validate-test-prompt] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedError && (sharedError.name === 'ReferenceError' || sharedError.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedError.name}: ${sharedError.message}`);
  }
});

test('[validate-test-prompt] test#1 prompt は末尾に date +%s（EPOCH_INSTRUCTION の実体）を含む', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(prompt.includes('date +%s'), 'test#1 prompt に "date +%s" が含まれていない');
});

test('[validate-test-prompt] test#1 prompt は trust-test-latest.json への証跡保存ブロックを含まない（issue #553）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(!prompt.includes('trust-test-latest'), 'test#1 prompt に trust-test-latest への言及が残っている（証跡保存ブロックの除去漏れ）');
  assert.ok(!prompt.includes('証跡保存'), 'test#1 prompt に「証跡保存」という語が残っている（証跡保存ブロックの除去漏れ）');
  assert.ok(!prompt.includes('Write tool'), 'test#1 prompt に Write tool による JSON 保存指示が残っている（証跡保存ブロックの除去漏れ）');
});

test('[validate-test-prompt] test#1 prompt は tests:"error" / tests:"failed" の両キーを含む（issue #619）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(prompt.includes('tests:"error"'), 'test#1 prompt に tests:"error" キーが含まれていない');
  assert.ok(prompt.includes('tests:"failed"'), 'test#1 prompt に tests:"failed" キーが含まれていない');
});

test('[validate-test-prompt] test#1 prompt は起動失敗を tests:"failed" に潰す旧文言を含まない（issue #619）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(
    !prompt.includes('それでも失敗するなら tests:"failed"'),
    '起動失敗を tests:"failed" に潰す旧文言が test#1 prompt に残っている',
  );
});
