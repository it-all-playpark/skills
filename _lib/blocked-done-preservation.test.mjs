// blocked-done-preservation.test.mjs
// AC#2: DONE×2+BLOCKED×1 → replan-blocked#1 プロンプトへの「適用済み」DONE 成果注入と
//       最終 implResults への DONE 結果（concerns 含む）マージ保持を VM sandbox で検証。
//
// このテストファイルは TDD red として作成された。
// 実装（F3）完了後に (a)(b)(c) が green になる。(d) は現行でも green（回帰ガード）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（design-replan-cap.test.mjs の makeSandbox / runDevFlowCapture をベースに改変）----
// harness は各テストファイルが自前で持つ（import 共有しない）。

function makeSandbox(analyzeReq) {
  const plannerCalls = [];
  const evalPrompts = [];
  const logMessages = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (agentType === 'dev-planner') {
      plannerCalls.push({ label, prompt });
      if (label === 'plan#standard') {
        return {
          summary: 'p',
          serial: [
            { id: 'T1', desc: 't1', file_changes: ['src/a.ts'] },
            { id: 'T2', desc: 't2', file_changes: ['src/b.ts'] },
            { id: 'T3', desc: 't3', file_changes: ['src/c.ts'] },
          ],
          parallel: [],
        };
      }
      if (label === 'replan-blocked#1') {
        return {
          summary: 'p2',
          serial: [{ id: 'T4', desc: 't4', file_changes: ['src/d.ts'] }],
          parallel: [],
        };
      }
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (agentType === 'implementer') {
      if (label === 'impl:serial:T1') {
        return {
          status: 'DONE',
          task_id: 'T1',
          files: ['src/a.ts'],
          summary: 'implemented A',
          concerns: ['T1-concern: null handling unverified'],
        };
      }
      if (label === 'impl:serial:T2') {
        return {
          status: 'DONE',
          task_id: 'T2',
          files: ['src/b.ts'],
          summary: 'implemented B',
          concerns: [],
        };
      }
      if (label === 'impl:serial:T3') {
        return {
          status: 'BLOCKED',
          task_id: 'T3',
          files: [],
          summary: '',
          concerns: [],
          blocking_reason: 'RZ: lib-z api missing',
        };
      }
      if (label === 'reimpl-blocked#1:serial:T4') {
        return {
          status: 'DONE',
          task_id: 'T4',
          files: ['src/d.ts'],
          summary: 'implemented D',
          concerns: [],
        };
      }
      return { status: 'DONE', task_id: 'T?', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      evalPrompts.push(prompt);
      return {
        verdict: 'pass',
        total: 9,
        threshold: 7,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
        critical_resolutions: [],
      };
    }
    if (agentType === 'dev-runner-haiku' && label === 'realized-diff') {
      return { files: ['src/a.ts'] };
    }
    if (agentType === 'dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['src/a.ts'] };
    }
    if (label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/a.ts'] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: (msg) => logMessages.push(String(msg)),
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    args: '1',
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };

  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    captures: {
      plannerCalls: () => plannerCalls,
      evalPrompts: () => evalPrompts,
      logs: () => logMessages,
    },
  };
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

// ============================================================
// テストケース（単一実行で全 assert）
// ============================================================

test('[blocked-done-preservation] AC#2: DONE成果の replan プロンプト注入と implResults マージ保持', async () => {
  // standard shape: count=4, AC=4, issue_type=fix
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 4,
    shape: 'standard',
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, captures } = makeSandbox(analyzeReq);
  const { error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const plannerCallsList = captures.plannerCalls();
  const evalPromptsList = captures.evalPrompts();

  // ---- replan-blocked#1 の prompt を取得（前提確認）----
  const replanBlocked1Call = plannerCallsList.find((c) => c.label === 'replan-blocked#1');
  assert.ok(
    replanBlocked1Call !== null && replanBlocked1Call !== undefined,
    'plannerCalls に label===replan-blocked#1 が存在しない。labels: '
      + plannerCallsList.map((c) => c.label).join(', '),
  );

  // (d) replan-blocked#2 が存在しない（T4 が DONE → blocked が空 → ループ脱出）
  // マージ実装が stale な T3 の BLOCKED を保持しすぎると b=2 で誤発火する回帰も検出する。
  // 注: (d) を先に assert することで「workflow が eval まで完走した」前提を兼ねて確認する。
  const replanBlocked2Call = plannerCallsList.find((c) => c.label === 'replan-blocked#2');
  assert.ok(
    replanBlocked2Call === null || replanBlocked2Call === undefined,
    '(d) T4 が DONE になった時点でループを脱出するため replan-blocked#2 は呼ばれてはいけない。\n'
      + 'stale な T3 BLOCKED が implResults に残ったままだと誤発火する。\n'
      + 'labels: ' + plannerCallsList.map((c) => c.label).join(', '),
  );

  const replanPrompt = replanBlocked1Call.prompt;

  // (a) replan-blocked#1 prompt に '適用済み' が含まれる
  // 現行実装では requirements/現計画/blockFindings のみ渡しており
  // DONE 成果の「適用済み」セクションが無い → red
  assert.ok(
    replanPrompt.includes('適用済み'),
    '(a) replan-blocked#1 prompt に「適用済み」が含まれるべきだが見つからない。\n'
      + '現行実装は requirements/現計画/blockFindings のみ渡しており DONE 成果のセクションがない。\n'
      + `prompt[:600]: ${replanPrompt.slice(0, 600)}`,
  );

  // (b) replan-blocked#1 prompt に T1/T2 の id・files・summary が含まれる
  // DONE task の成果（実装済みファイル・サマリ）が planner に伝わることで
  // 重複実装や矛盾設計を防ぐ。現行は渡していない → red
  assert.ok(
    replanPrompt.includes('T1'),
    '(b-id-T1) replan-blocked#1 prompt に DONE task id T1 が含まれるべき。\n'
      + `prompt[:600]: ${replanPrompt.slice(0, 600)}`,
  );
  assert.ok(
    replanPrompt.includes('T2'),
    '(b-id-T2) replan-blocked#1 prompt に DONE task id T2 が含まれるべき。\n'
      + `prompt[:600]: ${replanPrompt.slice(0, 600)}`,
  );
  assert.ok(
    replanPrompt.includes('src/a.ts'),
    '(b-files) replan-blocked#1 prompt に DONE task files src/a.ts が含まれるべき。\n'
      + `prompt[:600]: ${replanPrompt.slice(0, 600)}`,
  );
  assert.ok(
    replanPrompt.includes('implemented A'),
    '(b-summary) replan-blocked#1 prompt に DONE task summary "implemented A" が含まれるべき。\n'
      + `prompt[:600]: ${replanPrompt.slice(0, 600)}`,
  );

  // (c) evalPrompts[0]（eval#1）に T1 の concern が含まれる
  // 最終 implResults に DONE 結果（concerns 含む）がマージ保持され focus_areas へ伝搬するはず。
  // 現行は implResults が reimpl-blocked#1 の結果（T4 のみ）で上書きされ T1 concern が消失 → red
  assert.ok(
    evalPromptsList.length >= 1,
    `(c-前提) evalPrompts に 1 件以上あるべきだが ${evalPromptsList.length} 件`,
  );
  assert.ok(
    evalPromptsList[0].includes('T1-concern: null handling unverified'),
    '(c) evalPrompts[0] に "T1-concern: null handling unverified" が含まれるべき。\n'
      + '現行実装では implResults が reimpl-blocked#1 の結果（T4 のみ）で上書きされ T1 concern が消失する。\n'
      + `evalPrompts[0][:800]: ${evalPromptsList[0].slice(0, 800)}`,
  );
});
