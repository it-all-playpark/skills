import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

import { EVALUATOR_OPERATIONAL_CONTRACT, CONCERN_RESOLUTIONS, normalizeConcernResolution } from './evaluator-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
const evaluatorMd = readFileSync(join(repoRoot, '.claude/agents/evaluator.md'), 'utf8');

// ============================================================
// VM harness（final-ac-reconcile-routing.test.mjs の createResponder/makeSandbox パターンを踏襲）:
// dev-flow.js が実際に agent() へ渡す prompt を捕捉し、canonical contract の verbatim 注入を検証する。
// ============================================================

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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: false, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label === 'danger-grep') return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'H', empty: false } };
    if (label === 'danger-grep-final') return { ok: true, hits: [] };
    if (label === 'final-ac-reconcile') {
      return {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
          { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
        ],
      };
    }
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
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '1',
  });
}

const evaluatorContractBlock = [
  EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions,
  '',
  EVALUATOR_OPERATIONAL_CONTRACT.security_clearance,
].join('\n');

test('[evaluator-contract] evaluator.md contains the canonical _lib contract block verbatim', () => {
  assert.ok(
    evaluatorMd.includes(evaluatorContractBlock),
    'evaluator.md の critical_resolutions/security_clearance 契約が _lib/evaluator-contract.mjs と乖離しています',
  );
});

test('[evaluator-contract] evaluator.md contains the canonical concern_resolutions contract block verbatim', () => {
  assert.ok(
    evaluatorMd.includes(EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions),
    'evaluator.md の concern_resolutions 契約が _lib/evaluator-contract.mjs と乖離しています',
  );
});

// final_ac_reconcile 契約は evaluator.md へ mirror しない（issue #331 design decision）。
// .claude/agents/ は sandbox レベルの書き込み禁止領域であり、契約は dev-flow.js の
// final-ac-reconcile agent 呼び出し prompt への verbatim 注入のみで配送する（唯一の配送経路）。
// mirror 化する場合はこの pin ごと人間が明示的に変更すること。
test('[evaluator-contract] evaluator.md does NOT mirror the final_ac_reconcile contract (prompt-injection-only delivery, issue #331)', () => {
  assert.ok(
    !evaluatorMd.includes('final_ac_reconcile'),
    'final_ac_reconcile 契約は evaluator.md へ mirror せず、dev-flow.js の final-ac-reconcile prompt 注入のみで配送する設計。mirror 化する場合はこの pin ごと人間が変更すること',
  );
});

// concern_resolutions 契約は openConcerns.length>0（implementer concerns がある）ときにのみ
// eval#1 prompt へ注入される。standard shape の既定 responder は implementer concerns:[] を
// 返すため、この test だけ overrides で implementer concerns を与える。
test('[evaluator-contract] eval#1 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions / security_clearance / concern_resolutions verbatim', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ file: 'src/x.ts', class: 'network-egress', severity: 'critical', pattern: 'fetch' }] },
        files: ['src/x.ts'],
        struct: null,
        diffhash: { hash: 'H', empty: false },
      },
      'impl:serial:t1': { status: 'DONE_WITH_CONCERNS', task_id: 't1', files: ['src/x.ts'], summary: 's', concerns: ['未検証の入力値がある'] },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval1');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.security_clearance),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.security_clearance が verbatim 含まれていない（danger-grep hit による security_focus 注入）',
  );
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions が verbatim 含まれていない（未解消 concern 一覧による注入）',
  );
});

// critical_resolutions 契約は「未解消 critical 一覧」（前 iteration の critical feedback）または
// 「既出 feedback」が prompt に渡る場合にのみ注入される（eval#1 には prior state が無く注入されない）。
// complex shape の 2 iteration フィクスチャ（1 回目 critical → 2 回目解消）で eval#2 の prompt を検証する
// （_lib/eval-convergence.test.mjs の contract test と同じ理由）。
test('[evaluator-contract] eval#2 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions verbatim (issue #174)', async () => {
  const COMPLEX_REQ = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 7,
    shape: 'complex',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };
  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  const { ctx, calls } = makeSandbox({
    overrides: {
      'analyze#1': COMPLEX_REQ,
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts の入力検証を追加し test で確認' }],
      },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval2');
  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(evalCalls.length, 2, `evaluator は 2 回呼ばれるはずだが ${evalCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    evalCalls[1].prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions),
    'eval#2 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions が verbatim 含まれていない',
  );
});

test('[evaluator-contract] final-ac-reconcile prompt contains EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile verbatim', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-final-ac');
  const finalAc = calls.find((c) => c.label === 'final-ac-reconcile');
  assert.ok(finalAc != null, `label === 'final-ac-reconcile' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    finalAc.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile),
    'final-ac-reconcile の prompt に EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile が verbatim 含まれていない',
  );
});

// testsurf_clearance 契約は evaluator.md へ mirror しない（issue #362 design decision、final_ac_reconcile
// と同一 precedent）。.claude/agents/ は sandbox レベルの書き込み禁止領域であり、契約は dev-flow.js の
// testsurf_focus 注入 prompt への verbatim 注入のみで配送する（唯一の配送経路）。
// mirror 化する場合はこの pin ごと人間が明示的に変更すること。
test('[evaluator-contract] evaluator.md does NOT mirror the testsurf_clearance contract (prompt-injection-only delivery, issue #362)', () => {
  assert.ok(
    !evaluatorMd.includes('testsurf_clearance'),
    'testsurf_clearance 契約は evaluator.md へ mirror せず、dev-flow.js の testsurf_focus prompt 注入のみで配送する設計。mirror 化する場合はこの pin ごと人間が変更すること',
  );
});

test('[evaluator-contract] eval#1 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance verbatim when danger-grep reports a test-weakening hit', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ file: '_lib/foo.test.mjs', class: 'test-weakening', severity: 'critical', pattern: 'skip' }] },
        files: ['_lib/foo.test.mjs'],
        struct: null,
        diffhash: { hash: 'H', empty: false },
      },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-testsurf');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance が verbatim 含まれていない',
  );
});

test('[evaluator-contract] evaluator.md output example does not include schema-less score field', () => {
  assert.ok(!evaluatorMd.includes('"score"'), 'EVAL schema に無い score を evaluator.md の例に載せない');
});

test('[evaluator-contract] CONCERN_RESOLUTIONS is the closed 3-value enum', () => {
  assert.deepEqual(CONCERN_RESOLUTIONS, ['resolved', 'triaged', 'unresolved']);
});

test('[evaluator-contract] concern_resolutions contract mentions all 3 resolution values and {id, resolution, evidence}, not the legacy {id, resolved, evidence}', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions;
  for (const value of CONCERN_RESOLUTIONS) {
    assert.ok(contract.includes(value), `concern_resolutions 契約に '${value}' の説明が必要です`);
  }
  assert.ok(contract.includes('{id, resolution, evidence}'));
  assert.ok(!contract.includes('{id, resolved, evidence}'));
});

// #626 で撤回した旧仕様の文言が契約・evaluator.md に残っていないことだけを pin する（否定側のみ。
// 新仕様の言い回しは変えられるべきなので肯定側の文言 pin は置かない — issue #636 AC-1。
// 契約と evaluator.md の同期は上の verbatim mirror テストが担保する）。
test('[evaluator-contract][#626] concern_resolutions 契約と evaluator.md に旧「要対応に「トリアージ済み」として残る」が残っていない', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions;
  assert.ok(!contract.includes('triaged は要対応に「トリアージ済み」として残る'));
  assert.ok(!evaluatorMd.includes('triaged は要対応に「トリアージ済み」として残る'));
});

test('[normalizeConcernResolution] normalizes a well-formed triaged item', () => {
  const result = normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'triaged', evidence: 'e' });
  assert.deepEqual(result, { id: 'CONCERN-1', resolution: 'triaged', evidence: 'e' });
});

test('[normalizeConcernResolution] missing evidence normalizes to null', () => {
  const result = normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'unresolved' });
  assert.deepEqual(result, { id: 'CONCERN-1', resolution: 'unresolved', evidence: null });
});

test('[normalizeConcernResolution] legacy boolean key resolved throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ id: 'CONCERN-1', resolved: true, evidence: 'e' }),
    /resolved/,
  );
});

test('[normalizeConcernResolution] out-of-enum resolution throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'maybe', evidence: 'e' }),
    /out-of-enum/,
  );
});

test('[normalizeConcernResolution] missing id throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ resolution: 'resolved', evidence: 'e' }),
  );
});

test('[normalizeConcernResolution] null input throws', () => {
  assert.throws(() => normalizeConcernResolution(null));
});

test('[normalizeConcernResolution] array input throws', () => {
  assert.throws(() => normalizeConcernResolution(['CONCERN-1', 'resolved', 'e']));
});

test('[schema] dev-flow VERDICT.findings enforces stable stuck-detection fields', () => {
  assert.match(
    devFlowSrc,
    /findings:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'object',\s*required:\s*\['severity', 'dimension', 'topic', 'description', 'suggestion'\]/s,
    'dev-flow VERDICT.findings は item schema と required fields を持つ必要があります',
  );
});

test('[schema] pr-iterate REVIEW.issues enforces stable stuck-detection fields', () => {
  assert.match(
    prIterateSrc,
    /issues:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'object',\s*required:\s*\['severity', 'topic', 'file', 'description', 'suggestion'\]/s,
    'pr-iterate REVIEW.issues は item schema と topic/file/description を required にする必要があります',
  );
});
