// TDD red として作成。F3 実装（greenFixCount + 禁止文 + concerns 注入）までは fail する。
// テスト 1（green-fix prompt の禁止文）・テスト 2（evaluator prompt のテスト弱体化 focus）・
// テスト 5（dev-flow.js ソースの禁止文構造確認）は F3 実装前の現時点で fail する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';
import { TEST_WEAKENING } from './test-helpers/dev-flow-markers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ============================================================
// responder: green-fix あり経路専用の agent 応答
// test stub は 1 回目が failed (green:false)、2 回目以降は passed (green:true) を返す
// ことで green-fix#1 が 1 回だけ走る経路を再現する。
// testCallCount クロージャ状態を内包する。
// ============================================================

function createResponder() {
  let testCallCount = 0;
  return function({ label, agentType }) {
    // Setup(worktree)
    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a', 'b', 'c', 'd'],
        issue_type: 'fix',
        scope: 'src',
        estimated_change_file_count: 3,
        shape: 'standard',
      };
    }
    // Plan: dev-planner
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / danger-grep 系
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    // 1 回目は failed (green:false)、2 回目以降は passed (green:true)
    if (label.startsWith('test')) {
      testCallCount += 1;
      if (testCallCount === 1) {
        return { tests: 'failed', green: false, summary: 'assert mismatch in foo.test' };
      }
      return { tests: 'passed', green: true, summary: '' };
    }
    // Evaluate: evaluator
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }
    // realized-diff / declared-path-check / changed-files → files: [] で refloor を standard 維持
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
      return { files: [] };
    }
    // PR 系: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // implementer（green-fix も含む）
    // green-fix 経路の実装: files / summary を返す（issue #179 変更内容 2 の検証用）
    if (agentType === 'implementer' && label.startsWith('green-fix')) {
      return { status: 'DONE', task_id: 't', files: ['src/foo.test.ts'], summary: 'typo修正: 期待値が古いAPIを参照していた', concerns: [] };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    // デフォルト
    return null;
  };
}

// ============================================================
// 共有実行（tests 4, 3, 1, 2 が同じ sandbox 実行結果を参照するため）
// ============================================================

let sharedCalls = null;
let sharedErr = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(createResponder());
  const err = await runDevFlowInSandbox(src, ctx);
  sharedCalls = calls;
  sharedErr = err;
}

// ============================================================
// テスト 4: crash guard（shape-loop-routing.test.mjs と同じパターン）
// ============================================================

test('[green-fix-audit] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedErr && (sharedErr.name === 'ReferenceError' || sharedErr.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedErr.name}: ${sharedErr.message}`);
  }
});

// ============================================================
// テスト 3: sanity — green-fix call が 1 回以上発生していること
// ============================================================

test('[green-fix-audit] sanity: green-fix call が 1 回以上発生すること', async () => {
  await ensureSharedRun();
  const greenFixCalls = sharedCalls.filter((c) => c.label.startsWith('green-fix'));
  assert.ok(
    greenFixCalls.length >= 1,
    `green-fix label の call が 1 回以上発生すべきだが ${greenFixCalls.length} 回だった`
      + ` (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
});

// ============================================================
// テスト 1（AC#3）: green-fix#1 の prompt に禁止文が含まれること
// ============================================================

test('[green-fix-audit] AC#3: green-fix#1 の prompt に禁止文「テストの期待値・assert を弱めて green にすることは禁止」が含まれること', async () => {
  await ensureSharedRun();
  const greenFix1 = sharedCalls.find((c) => c.label === 'green-fix#1');
  assert.ok(
    greenFix1 != null,
    `label === 'green-fix#1' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    greenFix1.prompt.includes('テストの期待値・assert を弱めて green にすることは禁止'),
    `green-fix#1 の prompt に禁止文が含まれていない。\nprompt (先頭300文字):\n${greenFix1.prompt.slice(0, 300)}`,
  );
});

// ============================================================
// テスト 2（AC#1）: evaluator (eval#1) の prompt に「テスト弱体化」が含まれること
// ============================================================

test('[green-fix-audit] AC#1: eval#1 の prompt に「テスト弱体化」が含まれること（green-fix 発生時のテスト diff 重点監査 focus）', async () => {
  await ensureSharedRun();
  const eval1 = sharedCalls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes(TEST_WEAKENING),
    `eval#1 の prompt に「テスト弱体化」が含まれていない。\nprompt (先頭300文字):\n${eval1.prompt.slice(0, 300)}`,
  );
});

// ============================================================
// テスト 6（AC#2 補完）: eval#1 の prompt に green-fix が変更したファイルと申告根拠が含まれること
// issue #179 変更内容 2: 「green-fix の agent() 返り値（files / summary）を orchestrator が JS 変数で保持して渡す」
// ============================================================

test('[green-fix-audit] AC#2: eval#1 の prompt に green-fix が変更したファイルと申告された根拠が含まれること', async () => {
  await ensureSharedRun();
  const eval1 = sharedCalls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  // green-fix stub は files: ['src/foo.test.ts'], summary: 'typo修正...' を返す。
  // orchestrator がこれを蓄積して evaluator に渡すことを検証する。
  assert.ok(
    eval1.prompt.includes('src/foo.test.ts'),
    `eval#1 の prompt に green-fix が変更したファイル 'src/foo.test.ts' が含まれていない。\n`
      + `prompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`,
  );
  assert.ok(
    eval1.prompt.includes('申告された根拠'),
    `eval#1 の prompt に「申告された根拠」が含まれていない。\n`
      + `prompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`,
  );
  assert.ok(
    eval1.prompt.includes('typo修正'),
    `eval#1 の prompt に green-fix の summary テキスト 'typo修正' が含まれていない。\n`
      + `prompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`,
  );
});

// ============================================================
// テスト 5: 構造テスト（正の対）— dev-flow.js ソースに禁止文が含まれること
// ============================================================

test('[green-fix-audit][struct] dev-flow.js ソースに文字列「テストの期待値・assert を弱めて green にすることは禁止」が含まれること', () => {
  const src = readFileSync(devFlowPath, 'utf8');
  assert.ok(
    src.includes('テストの期待値・assert を弱めて green にすることは禁止'),
    'dev-flow.js に禁止文「テストの期待値・assert を弱めて green にすることは禁止」が存在すること',
  );
});
