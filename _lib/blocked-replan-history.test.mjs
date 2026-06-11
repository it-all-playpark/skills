// blocked-replan-history.test.mjs
// TDD red: case1 fails (R1 missing from replan-blocked#2 prompt), case2 passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

function makeSandbox(analyzeReq, implementerStub) {
  const plannerCalls = [];
  const evalPromptsList = [];
  const logMessages = [];
  const allCapturedCalls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    allCapturedCalls.push({ label, agentType, prompt });
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (agentType === 'dev-planner') {
      plannerCalls.push({ label, prompt });
      if (label === 'plan#standard') {
        return { summary: 'p', serial: [{ id: 'T1', desc: 't1', file_changes: ['src/a.ts'] }], parallel: [] };
      }
      if (label === 'replan-blocked#1') {
        return { summary: 'p', serial: [{ id: 'T2', desc: 't2', file_changes: ['src/b.ts'] }], parallel: [] };
      }
      if (label === 'replan-blocked#2') {
        return { summary: 'p', serial: [{ id: 'T3', desc: 't3', file_changes: ['src/c.ts'] }], parallel: [] };
      }
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (agentType === 'implementer') {
      return implementerStub(prompt, opts);
    }
    if (label.startsWith('danger-grep')) {
      return { hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      evalPromptsList.push(prompt);
      return {
        verdict: 'pass', total: 9, threshold: 7, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], critical_resolutions: [],
      };
    }
    if (agentType === 'dev-runner-haiku' && (label === 'realized-diff' || label === 'declared-path-check')) {
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

  const parallelStub = (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'LGTM' });

  const sandbox = {
    phase: () => {},
    log: (msg) => logMessages.push(String(msg)),
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    args: '1',
    console, JSON, Math, String, Number, Boolean, Array, Object,
    Error, RegExp, Promise, Symbol, Map, Set, Date,
  };

  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    captures: {
      plannerCalls: () => plannerCalls,
      evalPrompts: () => evalPromptsList,
      logs: () => logMessages,
      capturedCalls: () => allCapturedCalls,
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
      resolvedResult = await resultPromise.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

// standard shape: count=4 (3-5), AC<=6, issue_type=fix, no breaking keywords
const STANDARD_ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 4,
  shape: 'standard',
};

// case1: BLOCKED x2 -> replan-blocked#2 prompt must include R1 AND R2
// current impl only passes current-iteration blockFindings -> R1 missing -> red
test('[blocked-replan-history] case1: cumulative blockSeen', async () => {
  const implementerStubBlocked = (prompt, opts) => {
    const label = opts?.label ?? '';
    if (label === 'impl:serial:T1') {
      return { status: 'BLOCKED', task_id: 'T1', files: [], summary: '', concerns: [],
               blocking_reason: 'R1: patch-api approach failed' };
    }
    if (label === 'reimpl-blocked#1:serial:T2') {
      return { status: 'BLOCKED', task_id: 'T2', files: [], summary: '', concerns: [],
               blocking_reason: 'R2: hook approach failed' };
    }
    if (label === 'reimpl-blocked#2:serial:T3') {
      return { status: 'BLOCKED', task_id: 'T3', files: [], summary: '', concerns: [],
               blocking_reason: 'R3: rewrite approach failed' };
    }
    const m = label.match(/:([^:]+)$/);
    return { status: 'DONE', task_id: m ? m[1] : 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, captures } = makeSandbox(STANDARD_ANALYZE_REQ, implementerStubBlocked);
  const { error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js crashed in sandbox: ' + error.name + ': ' + error.message);
  }

  const plannerCalls = captures.plannerCalls();
  const logs = captures.logs();
  const evalPrompts = captures.evalPrompts();

  // (a) replan-blocked#2 call must exist
  const replanBlocked2Call = plannerCalls.find((c) => c.label === 'replan-blocked#2');
  assert.ok(
    replanBlocked2Call !== null && replanBlocked2Call !== undefined,
    'plannerCalls must contain label===replan-blocked#2. labels: ' + plannerCalls.map((c) => c.label).join(', '),
  );

  // (b) replan-blocked#2 prompt must contain R1 (from iteration#1) AND R2
  // Current impl only passes current iteration blocked => R1 missing => RED
  const prompt2 = replanBlocked2Call.prompt;
  assert.ok(
    prompt2.includes('R1: patch-api approach failed'),
    'replan-blocked#2 prompt must contain R1: patch-api approach failed (cumulative blockFindings not injected). prompt[:500]: ' + prompt2.slice(0, 500),
  );
  assert.ok(
    prompt2.includes('R2: hook approach failed'),
    'replan-blocked#2 prompt must contain R2: hook approach failed. prompt[:500]: ' + prompt2.slice(0, 500),
  );

  // (c) logs must contain BLOCK_MAX reached message
  assert.ok(
    logs.some((m) => m.includes('2 回再計画しても')),
    'logs must contain BLOCK_MAX reached log. logs: ' + logs.join(' | '),
  );

  // (d) evalPrompts[0] must contain R3 (blockedConcerns -> concerns -> focus_areas)
  assert.ok(evalPrompts.length >= 1, 'evalPrompts must have >= 1 entry, got ' + evalPrompts.length);
  assert.ok(
    evalPrompts[0].includes('R3: rewrite approach failed'),
    'evalPrompts[0] must contain R3: rewrite approach failed. evalPrompts[0][:800]: ' + evalPrompts[0].slice(0, 800),
  );
});

// case2: all DONE -> no replan-blocked calls (regression guard - must pass with current impl)
test('[blocked-replan-history] case2: all tasks DONE - no replan', async () => {
  const implementerStubDone = (prompt, opts) => {
    const label = opts?.label ?? '';
    const m = label.match(/:([^:]+)$/);
    return { status: 'DONE', task_id: m ? m[1] : 'T1', files: ['src/a.ts'], summary: 'ok', concerns: [] };
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, captures } = makeSandbox(STANDARD_ANALYZE_REQ, implementerStubDone);
  const { error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js crashed in sandbox: ' + error.name + ': ' + error.message);
  }

  const plannerCalls = captures.plannerCalls();
  const logs = captures.logs();

  const replanBlockedCalls = plannerCalls.filter((c) => c.label.startsWith('replan-blocked'));
  assert.equal(
    replanBlockedCalls.length, 0,
    'When all DONE, replan-blocked calls must be 0 but got ' + replanBlockedCalls.length
    + ': ' + replanBlockedCalls.map((c) => c.label).join(', '),
  );

  const blockedLogs = logs.filter((m) => m.includes('BLOCKED'));
  assert.equal(
    blockedLogs.length, 0,
    'When all DONE, no BLOCKED logs expected but got ' + blockedLogs.length + ': ' + blockedLogs.join('; '),
  );
});
