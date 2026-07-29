// guard-blocked-routing.test.mjs
// dev-flow.js の execImplementPhase native wiring（issue #448 F3）を VM sandbox で検証する。
// blocked-replan-history.test.mjs（label ベースの implementer stub パターン）と
// devflow-failure-telemetry-routing.test.mjs（journal-log prompt からの telemetry 抽出パターン）
// を踏襲する。
//
// 検証対象:
// (a) guard_blocked task は replan-blocked# を 0 回にし、blockSeen へ approach_mismatch findings
//     を一切残さず（全 planner prompt に現れない）、evaluator の focus_areas に
//     guard_blocked(<task_id>) 接頭辞の concern を到達させる
// (b) 全 captured agent prompt に迂回語彙（fetch|FETCH_HEAD|mirror|checkout）が一切現れない
//     （run wf_17d7a7be 相当の実迂回コマンド列 fixture を使用）
// (c) journal handoff payload（journal-log prompt）に error_category:guard_blocked と
//     guard_id が到達する
// (d) guard_blocked と approach_mismatch 混在時、approach 側のみ replan-blocked#1 が発火し
//     その prompt にスクラブ済み finding が入る
// (e) 旧 string blocking_reason を返す stub は partition throw で明示 error になる

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// run wf_17d7a7be 相当の実迂回コマンド列 fixture（issue #448 の実害）。
const EVASION_COMMAND_FIXTURE =
  'git clone --mirror https://github.com/it-all-playpark/skills /tmp/m && '
  + 'git -C <wt> fetch /tmp/m && '
  + 'git checkout FETCH_HEAD -- .claude/workflows/dev-flow.js';

const EVASION_VOCAB_RE = /fetch|FETCH_HEAD|mirror|checkout/i;

const STANDARD_ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 4,
  shape: 'standard',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function makeSandbox({ implementerFn, plannerFn } = {}) {
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const entry = { label, agentType, prompt: String(prompt ?? '') };
    calls.push(entry);

    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label.startsWith('analyze')) return STANDARD_ANALYZE_REQ;
    if (agentType === 'dev-planner') {
      if (plannerFn) return plannerFn(label, opts);
      return { summary: 'p', serial: [{ id: 'T1', desc: 't1', file_changes: ['src/a.ts'] }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/a.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/a.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: STANDARD_ANALYZE_REQ.acceptance_criteria.map((_, i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') return { logged: true, summary: 'ok' };
    if (label === 'journal-log-failure') return null;
    if (agentType === 'implementer') return implementerFn(label, opts);
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub, parallel: parallelStub,
    workflow: workflowStub, args: '1',
    console, JSON, Math, String, Number, Boolean, Array, Object, Error,
    RegExp, Promise, Symbol, Map, Set, Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

async function runDevFlowInSandbox(ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;
  let caughtError = null;
  let result = null;
  try {
    const promise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (promise && typeof promise.then === 'function') {
      result = await promise.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, result };
}

// ============================================================
// (a)+(b)+(c): 単一 task が guard_blocked
// ============================================================
test('[guard-blocked-routing] guard_blocked task: replan 0回・blockSeen非登録・evaluator focus_areas到達・迂回語彙非混入・telemetry到達', async () => {
  const implementerFn = (label) => {
    if (label === 'impl:serial:T1') {
      return {
        status: 'BLOCKED', task_id: 'T1', files: [], summary: '', concerns: [],
        blocking_reason: { block_class: 'guard_blocked', guard_id: 'inline-edit-guard', detail: EVASION_COMMAND_FIXTURE },
      };
    }
    return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
  };

  const { ctx, calls } = makeSandbox({ implementerFn });
  const { error, result } = await runDevFlowInSandbox(ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `guard_blocked のみの run は throw しないはずだが: ${error?.message}`);

  // (a) replan-blocked# の呼び出しが 0 回
  const replanCalls = calls.filter((c) => c.label.startsWith('replan-blocked'));
  assert.equal(replanCalls.length, 0,
    `guard_blocked task は replan-blocked を発火しないはずだが ${replanCalls.length} 回発火した`);

  // (a) 全 planner prompt に approach_mismatch findings が現れない（blockSeen 非登録の検証）
  const plannerCalls = calls.filter((c) => c.agentType === 'dev-planner');
  for (const c of plannerCalls) {
    assert.ok(!c.prompt.includes('"dimension":"approach_mismatch"'),
      `planner prompt(label=${c.label}) に approach_mismatch findings が混入している: ${c.prompt.slice(0, 300)}`);
  }

  // (a) evaluator prompt の focus_areas に guard_blocked(<task_id>) 接頭辞の concern が到達する
  const evalCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(evalCalls.length >= 1, 'evaluator 呼び出しが 1 回以上あるはず');
  assert.ok(evalCalls[0].prompt.includes('guard_blocked(T1)[guard=inline-edit-guard]'),
    `evaluator prompt に guard_blocked(T1) 接頭辞の concern が含まれるべきだが:\n${evalCalls[0].prompt.slice(0, 800)}`);

  // (b) blocking_reason が注入される 2 下流（replan prompt / evaluator prompt）に迂回語彙が一切現れない
  //     （AC-5: replan/evaluator prompt への注入点をスクラバーが無害化することの検証）
  const injectionCalls = calls.filter((c) => c.agentType === 'dev-planner' || c.agentType === 'evaluator');
  assert.ok(injectionCalls.length >= 1, 'dev-planner/evaluator の呼び出しが 1 回以上あるはず');
  for (const c of injectionCalls) {
    assert.equal(EVASION_VOCAB_RE.test(c.prompt), false,
      `prompt(label=${c.label}, agentType=${c.agentType}) に迂回語彙が混入している: ${c.prompt.slice(0, 400)}`);
  }

  // (c) journal handoff payload に error_category:guard_blocked と guard_id が到達する
  const journalCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-runner-haiku');
  assert.equal(journalCalls.length, 1, `journal-log(success) は 1 回のはずだが ${journalCalls.length} 回だった`);
  const journalPrompt = journalCalls[0].prompt;
  assert.ok(journalPrompt.includes('"error_category":"guard_blocked"'),
    `journal payload に "error_category":"guard_blocked" が含まれるべきだが:\n${journalPrompt.slice(0, 800)}`);
  assert.ok(journalPrompt.includes('"guard_id":"inline-edit-guard"'),
    `journal payload に "guard_id":"inline-edit-guard" が含まれるべきだが:\n${journalPrompt.slice(0, 800)}`);

  assert.ok(result?.pr_url != null, `完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)} だった`);
});

// ============================================================
// (d): guard_blocked と approach_mismatch 混在
// ============================================================
test('[guard-blocked-routing] guard_blocked/approach_mismatch 混在: approach 側のみ replan-blocked#1 が発火しスクラブ済み finding が入る', async () => {
  const plannerFn = (label) => {
    if (label === 'plan#standard') {
      return { summary: 'p', serial: [{ id: 'T1', desc: 't1', file_changes: ['src/a.ts'] }, { id: 'T2', desc: 't2', file_changes: ['src/b.ts'] }], parallel: [] };
    }
    if (label === 'replan-blocked#1') {
      return { summary: 'p', serial: [{ id: 'T3', desc: 't3', file_changes: ['src/c.ts'] }], parallel: [] };
    }
    return { summary: 'p', serial: [], parallel: [] };
  };
  const implementerFn = (label) => {
    if (label === 'impl:serial:T1') {
      return {
        status: 'BLOCKED', task_id: 'T1', files: [], summary: '', concerns: [],
        blocking_reason: { block_class: 'guard_blocked', guard_id: 'inline-edit-guard', detail: EVASION_COMMAND_FIXTURE },
      };
    }
    if (label === 'impl:serial:T2') {
      return {
        status: 'BLOCKED', task_id: 'T2', files: [], summary: '', concerns: [],
        blocking_reason: { block_class: 'approach_mismatch', detail: 'patch-api approach failed' },
      };
    }
    if (label === 'reimpl-blocked#1:serial:T3') {
      return { status: 'DONE', task_id: 'T3', files: ['src/c.ts'], summary: 'ok', concerns: [] };
    }
    return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
  };

  const { ctx, calls } = makeSandbox({ implementerFn, plannerFn });
  const { error } = await runDevFlowInSandbox(ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `mixed guard/approach run は throw しないはずだが: ${error?.message}`);

  const replanCalls = calls.filter((c) => c.label.startsWith('replan-blocked'));
  assert.equal(replanCalls.length, 1,
    `approach_mismatch(T2) のみ replan-blocked#1 を 1 回発火すべきだが ${replanCalls.length} 回だった`);
  assert.ok(replanCalls[0].prompt.includes('patch-api approach failed'),
    `replan-blocked#1 prompt にスクラブ済み finding が含まれるべきだが:\n${replanCalls[0].prompt.slice(0, 800)}`);
  // guard_blocked(T1) は findings 化されず除去済み — approach_mismatch findings は T2 の 1 件のみのはず
  const findingCount = (replanCalls[0].prompt.match(/"dimension":"approach_mismatch"/g) || []).length;
  assert.equal(findingCount, 1,
    `replan-blocked#1 prompt の approach_mismatch findings は T2 の 1 件のみのはずだが ${findingCount} 件だった:\n${replanCalls[0].prompt.slice(0, 800)}`);
  const injectionCalls = calls.filter((c) => c.agentType === 'dev-planner' || c.agentType === 'evaluator');
  for (const c of injectionCalls) {
    assert.equal(EVASION_VOCAB_RE.test(c.prompt), false,
      `prompt(label=${c.label}, agentType=${c.agentType}) に迂回語彙が混入している: ${c.prompt.slice(0, 400)}`);
  }
});

// ============================================================
// (e): 旧 string blocking_reason を返す stub は throw で明示 error
// ============================================================
test('[guard-blocked-routing] 旧 string blocking_reason: partition throw が明示 error として伝播する', async () => {
  const implementerFn = (label) => {
    if (label === 'impl:serial:T1') {
      return { status: 'BLOCKED', task_id: 'T1', files: [], summary: '', concerns: [], blocking_reason: 'free text blocked' };
    }
    return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
  };

  const { ctx } = makeSandbox({ implementerFn });
  const { error } = await runDevFlowInSandbox(ctx);

  assert.ok(error !== null, '旧 string blocking_reason は throw で検出されるべきだが error が null だった');
});
