// issue #413 (epic #390 Phase 5) F4: dev-flow.js telemetry handoff への trust_run_id 配線
// routing test。
//
// 本ファイルは _lib/effectdelta-routing.test.mjs の手法（vitest + fs で dev-flow.js ソースを
// 読み regex/文字列 assert する）を踏襲し、journal-log telemetry への trust_run_id 条件付き
// emission が意図どおり配線されていることを assert する:
//
//   (a) telemetry に trust_run_id の条件付き emission が存在する（静的確認）
//   (b) 条件が state.trustSurfaceProofShadow || state.trustReceipts.length である（静的確認）
//   (c) comment-ensure の --run-id と telemetry の trust_run_id が同一の定数（RUN_ID）を
//       参照する（静的確認: RUN_ID 宣言が単一である）
//   (d) repo が allowlist 不一致（trust 非活性）→ journal telemetry に trust_run_id が
//       出現しない（AC-11/AC-15: byte 互換の実測）
//   (e) repo=allowlist（SurfaceProof shadow probe 実行 → trustSurfaceProofShadow 非 null）→
//       journal telemetry の trust_run_id が comment-ensure prompt の --run-id と同一値
//       （実測）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// runDevFlowCapture: effectdelta-routing.test.mjs と同型のローカル copy（{result, error} を返す）。
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

const ALLOWLISTED_REPO = 'it-all-playpark/skills';

const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 413,
  issue_title: 'stub-issue-title',
};

function evaluatorResponseFor(req) {
  return {
    verdict: 'pass', total: 100, threshold: 80, feedback: [],
    feedback_level: 'implementation',
    ac_results: (req.acceptance_criteria ?? []).map((_, i) => ({
      ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok',
    })),
    security_clearance: [], concern_resolutions: [],
  };
}

// createResponder: effectdelta-routing.test.mjs と同型。repo:null/undefined は 'worktree' 応答から
// repo フィールドを省略（allowlist 不一致 → 全 trust layer off）。
function createResponder({ repo = null, req = STANDARD_REQ, overrides = {} } = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-413', ...(repo ? { repo } : {}) };
    if (label.startsWith('analyze')) return req;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (agentType === 'evaluator') return evaluatorResponseFor(req);
    if (agentType === 'pr-reviewer') return { decision: 'approve', issues: [] };
    if (label.startsWith('ci-check')) return { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 0 };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/x.ts'] };
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'gh-pr-view') return { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label.startsWith('trust-') || label.startsWith('surfaceproof-shadow')) return null;
    if (label === 'issue-meta') return { ok: true, number: 413, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ repo = null, req = STANDARD_REQ, overrides = {}, fixesApplied = 0 } = {}) {
  const { ctx, calls } = makeRecordingSandbox(createResponder({ repo, req, overrides }), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '413',
  });
  return { ctx, calls };
}

// journal-log prompt から telemetry payload を JSON.parse して返す（effectdelta-routing.test.mjs の
// extractTelemetryPayload と同型）。
function extractTelemetryPayload(prompt) {
  if (typeof prompt !== 'string') return null;
  // issue #433: journal-handoff.mjs の journal-log prompt は buildJournalHandoffInstr の
  // Write-tool verbatim delimiter（<<<JOURNAL_HANDOFF_BODY_BEGIN/END>>>）で payload を囲む
  // （旧 heredoc `TELEMETRY_EOF` 形式は撤去済み）。
  const m = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n(\{[\s\S]*?\})\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function sampleReceipt() {
  return {
    schema_version: 'surfaceproof/1',
    outcome: { verdict: 'pass', reason_code: 'OK' },
    receipt_id: 'r-sp',
  };
}

// ============================================================
// (a) telemetry に trust_run_id の条件付き emission が存在する（静的確認）
// ============================================================

test('[trust-run-id] (a) dev-flow.js の journal-log telemetry object に trust_run_id の条件付き emission が存在する', () => {
  assert.match(
    devFlowSrc,
    /\{\s*trust_run_id:\s*RUN_ID\s*\}/,
    'telemetry object に `trust_run_id: RUN_ID` の conditional spread が見つからない',
  );
});

// ============================================================
// (b) 条件が state.trustSurfaceProofShadow || state.trustReceipts.length である（静的確認）
// ============================================================

test('[trust-run-id] (b) trust_run_id の emission 条件が state.trustSurfaceProofShadow || state.trustReceipts.length である', () => {
  assert.match(
    devFlowSrc,
    /\.\.\.\(state\.trustSurfaceProofShadow \|\| state\.trustReceipts\.length \? \{ trust_run_id: RUN_ID \} : \{\}\)/,
    'trust_run_id の conditional 条件式が期待どおり（state.trustSurfaceProofShadow || state.trustReceipts.length）でない',
  );
});

// ============================================================
// (c) comment-ensure の --run-id と telemetry の trust_run_id が同一定数（RUN_ID）を参照する
// （RUN_ID 宣言が単一であることを静的確認 — dual-declaration があると同一性が壊れる）
// ============================================================

test('[trust-run-id] (c) RUN_ID の宣言は単一（comment-ensure --run-id と telemetry trust_run_id が同一定数を共有）', () => {
  const declarations = devFlowSrc.match(/const RUN_ID = /g) ?? [];
  assert.equal(declarations.length, 1, `RUN_ID の宣言は 1 箇所のみであるべきだが ${declarations.length} 箇所見つかった`);
  assert.match(
    devFlowSrc,
    /const RUN_ID = String\(clockMarks\?\.start \?\? ISSUE\)/,
    'RUN_ID の算出式が変更されている（値・算出式は不変であるべき）',
  );
  assert.match(
    devFlowSrc,
    /--run-id \$\{RUN_ID\}/,
    'comment-ensure コマンドの --run-id が RUN_ID を参照していない',
  );
});

// ============================================================
// (d) repo が allowlist 不一致（trust 非活性）→ journal telemetry に trust_run_id が出現しない
// （AC-11/AC-15: byte 互換の実測）
// ============================================================

test('[trust-run-id] (d) repo が allowlist 不一致（trust 非活性）→ journal telemetry に trust_run_id が出現しない', async () => {
  const { ctx, calls } = makeSandbox({ repo: null });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(d) 'journal-log' の呼び出しが存在すること");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, '(d) journal-log prompt から telemetry payload を JSON.parse できるはず');
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.telemetry ?? {}, 'trust_run_id'),
    false,
    '(d) trust 非活性 run（repo allowlist 不一致）の telemetry に trust_run_id キーが出現してはならない',
  );
});

// ============================================================
// (e) repo=allowlist（SurfaceProof shadow probe 実行 → trustSurfaceProofShadow 非 null）→
// journal telemetry の trust_run_id が comment-ensure prompt の --run-id と同一値（実測）
// ============================================================

test('[trust-run-id] (e) repo=allowlist（trust 活性）→ journal telemetry の trust_run_id が comment-ensure --run-id と同一値', async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'surfaceproof-shadow#413': { ok: true, result: { receipt: sampleReceipt() } },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e');
  assert.ok(result !== null, '(e) workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(e) 'journal-log' の呼び出しが存在すること");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, '(e) journal-log prompt から telemetry payload を JSON.parse できるはず');
  assert.ok(
    Object.prototype.hasOwnProperty.call(payload.telemetry ?? {}, 'trust_run_id'),
    '(e) trust 活性 run（SurfaceProof shadow probe 実行）の telemetry に trust_run_id キーが存在するはず',
  );

  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall, "(e) 'post-summary' 呼び出しが存在するはず");
  const m = postSummaryCall.prompt.match(/--run-id ([^\s`]+)/);
  assert.ok(m, '(e) post-summary prompt に --run-id が含まれるはず');
  assert.equal(
    String(payload.telemetry.trust_run_id),
    m[1],
    `(e) telemetry.trust_run_id (${payload.telemetry.trust_run_id}) は comment-ensure --run-id (${m[1]}) と同一値のはず`,
  );
});
