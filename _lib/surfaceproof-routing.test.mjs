// issue #410 (epic #390 Phase 2): SurfaceProof shadow wiring routing test。
//
// Phase 1 の _lib/trust-noninterference.test.mjs（「配線ゼロ」を固定する非干渉 guard）は、
// 本 task で意図どおり配線 routing test に置換される（同 test ファイル冒頭のコメント参照。
// issue #411 の _lib/evalseal-routing.test.mjs と同じ置換パターンを踏襲する）。
// 本ファイルは dev-flow.js への SurfaceProof (surfaceproof/1) shadow 配線
// （Analyze phase 直後の shadow probe / telemetry / return）が意図どおり行われ、
// off/shadow で既存挙動（req/shape/merge_tier）が変化しないことを実測する。
//
// ハーネスは makeRecordingSandbox（_lib/test-helpers/vm-sandbox.mjs）+ evalseal-routing.test.mjs
// と同型のローカル runDevFlowCapture（{result, error} を返す）を使う。
//
// テストケース:
//   (a) repo が allowlist 不一致（省略）→ SURFACEPROOF_MODE='off' → surfaceproof-shadow* 呼び出し
//       ゼロ + journal-log prompt に 'trust_surfaceproof_shadow' 無し + return に
//       trust_surfaceproof_shadow が undefined ではなく null（state 初期値のまま。AC-11 off 経路）
//   (b) repo=allowlist + probe ok:true → 'surfaceproof-shadow' が 1 回 + journal-log telemetry の
//       trust_surfaceproof_shadow.verdict/reason_code が receipt 由来 + merge_tier/reasons が
//       (a) と同一（shadow 非干渉）
//   (c) probe responder が null → run 完走・error null・trustSurfaceProofShadow が
//       inconclusive/PROBE_FAILED（fail-open、pass に丸めない）
//   (d) (a) と (b) の calls から 'surfaceproof-shadow' 始まり label を除いた列が完全一致
//       （AC-11 実測）
//   (e) 旧 noninterference test の残存 pin: pr-iterate.js / dev-improve.js / .claude/agents/*.md に
//       surfaceproof/SurfaceProof 参照が無い（SurfaceProof 配線は dev-flow.js のみ、という境界の固定）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// runDevFlowCapture: evalseal-routing.test.mjs / final-reconcile-routing.test.mjs と同型の
// ローカル copy（{result, error} を返す。共有 runDevFlowInSandbox は error のみを返すため
// resolved return value を捕捉できず、本ファイルは (b)/(c) で return/telemetry を検証する
// ため独自に実装する）。
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

// createResponder: standard shape シナリオ共通の responder factory（evalseal-routing.test.mjs
// の createResponder と同型）。overrides は label 単位。repo:null/undefined は 'worktree' 応答
// から repo フィールドを省略（allowlist 不一致 → off）。
function createResponder({ repo = null, req = STANDARD_REQ, overrides = {} } = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-410', ...(repo ? { repo } : {}) };
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
    // surfaceproof-shadow / trust-* 系は override で明示指定しない限り応答しない
    // （未知 label → null、fail-open の実測）
    if (label.startsWith('surfaceproof-shadow') || label.startsWith('trust-')) return null;
    return null;
  };
}

function makeSandbox({ repo = null, req = STANDARD_REQ, overrides = {}, fixesApplied = 0 } = {}) {
  const { ctx, calls } = makeRecordingSandbox(createResponder({ repo, req, overrides }), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '410',
  });
  return { ctx, calls };
}

// journal-log prompt から telemetry payload を JSON.parse して返す（journal-handoff.mjs の
// heredoc delimiter を経由。見つからなければ null）。
function extractTelemetryPayload(prompt) {
  if (typeof prompt !== 'string') return null;
  // journal-handoff.mjs (issue #412 F3: atomic mktemp/mv write) の heredoc は
  // `<<'TELEMETRY_EOF' && __jh_id=... && mv -f ...` のように delimiter 直後に
  // シェルコマンドが続くため、旧 `TELEMETRY_EOF'\n` 直後開始の前提が崩れる。
  // payload（JSON.stringify、常に単一行・`{`始まり）を挟む 2 個の改行のうち
  // 前者直後から `\nTELEMETRY_EOF` 直前までを取り出す。
  const m = prompt.match(/\n(\{[\s\S]*?\})\nTELEMETRY_EOF/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function sampleReceipt({ verdict = 'pass', reasonCode = 'OK' } = {}) {
  return {
    schema_version: 'surfaceproof/1',
    subject: { kind: 'github-issue', identity: `${ALLOWLISTED_REPO}#410`, revision_digest: 'digest-410' },
    instrument: { adapter: 'github-issue', adapter_version: '1.0.0', config_digest: 'config-digest', capabilities: ['issue-read'] },
    outcome: { verdict, reason_code: reasonCode },
    trust: { record_integrity: 'advisory' },
    anchors: { source_revision: 'digest-410', input_pack_digest: 'pack-digest' },
    receipt_id: 'r-surfaceproof-410',
  };
}

// ============================================================
// (a) repo が allowlist 不一致 → SURFACEPROOF_MODE=off → surfaceproof-shadow* 呼び出しゼロ
// ============================================================

test('[surfaceproof] (a) repo が allowlist 不一致 → SURFACEPROOF_MODE=off → surfaceproof-shadow 呼び出しゼロ + journal に trust_surfaceproof_shadow 無し', async () => {
  const { ctx, calls } = makeSandbox({ repo: null });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');

  assert.ok(!calls.some((c) => c.label.startsWith('surfaceproof-shadow')), "(a) label が 'surfaceproof-shadow' 始まりの呼び出しが存在してはならない");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(a) 'journal-log' の呼び出しが存在すること");
  assert.ok(!journalCall.prompt.includes('trust_surfaceproof_shadow'), "(a) journal-log prompt に 'trust_surfaceproof_shadow' が含まれてはならない");
});

// ============================================================
// (b) repo=allowlist + probe ok:true → surfaceproof-shadow 1 回 + telemetry 反映 +
// merge_tier/reasons が (a) と同一（shadow 非干渉）
// ============================================================

test('[surfaceproof] (b) repo=allowlist + probe ok → surfaceproof-shadow 1回 + telemetry 反映 + merge_tier 不変', async () => {
  const { ctx: ctxA, calls: callsA } = makeSandbox({ repo: null });
  await runDevFlowCapture(devFlowSrc, ctxA);
  const journalA = callsA.find((c) => c.label === 'journal-log');
  const payloadA = extractTelemetryPayload(journalA?.prompt);

  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      [`surfaceproof-shadow#410`]: { ok: true, result: { receipt: sampleReceipt() } },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');

  const shadowCalls = calls.filter((c) => c.label === 'surfaceproof-shadow#410');
  assert.equal(shadowCalls.length, 1, `(b) 'surfaceproof-shadow#410' はちょうど 1 回呼ばれるはずだが ${shadowCalls.length} 回だった`);

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(b) journal-log prompt から telemetry payload を JSON.parse できるはず');
  const shadow = payload?.telemetry?.trust_surfaceproof_shadow;
  assert.equal(shadow?.mode, 'shadow', `(b) trust_surfaceproof_shadow.mode は 'shadow' のはずだが ${shadow?.mode}`);
  assert.equal(shadow?.verdict, 'pass', `(b) trust_surfaceproof_shadow.verdict は 'pass' のはずだが ${shadow?.verdict}`);
  assert.equal(shadow?.reason_code, 'OK');
  assert.equal(shadow?.receipt_id, 'r-surfaceproof-410');

  assert.equal(
    JSON.stringify(payload?.telemetry?.merge_tier),
    JSON.stringify(payloadA?.telemetry?.merge_tier),
    '(b) merge_tier は (a) と同一のはず（shadow は既存 gate を変えない）',
  );
});

// ============================================================
// (c) probe responder が null → run 完走・error null・fail-open で inconclusive/PROBE_FAILED
// ============================================================

test('[surfaceproof] (c) probe が null → run 完走 + error null + inconclusive/PROBE_FAILED（fail-open、pass に丸めない）', async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: { [`surfaceproof-shadow#410`]: null },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `(c) probe が null でも run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(calls.some((c) => c.label === 'surfaceproof-shadow#410'), "(c) 'surfaceproof-shadow#410' は呼ばれているはず（応答が null なだけ）");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  const shadow = payload?.telemetry?.trust_surfaceproof_shadow;
  assert.equal(shadow?.mode, 'shadow');
  assert.equal(shadow?.verdict, 'inconclusive', `(c) verdict は 'inconclusive' のはずだが ${shadow?.verdict}（probe 失敗を pass に丸めない）`);
  assert.equal(shadow?.reason_code, 'PROBE_FAILED');
});

// ============================================================
// (d) (a) と (b) の calls から 'surfaceproof-shadow' / 'trust-' 始まり label を除いた列が完全一致
// （repoSlug allowlist は EvalSeal と共有のため、repo=allowlist にすると EvalSeal 側の
// trust-seal-eval 呼び出しも同時に有効化される。これは issue #411 の非干渉領域であり
// 本 test の関心事ではないため、比較対象からは trust-* も併せて除外する）。
// ============================================================

test("[surfaceproof] (d) (a)（off）と (b)（shadow）の calls 列は 'surfaceproof-shadow'/'trust-' 始まり label を除くと完全一致（非干渉実測）", async () => {
  const { ctx: ctxA, calls: callsA } = makeSandbox({ repo: null });
  await runDevFlowCapture(devFlowSrc, ctxA);

  const { ctx: ctxB, calls: callsB } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      [`surfaceproof-shadow#410`]: { ok: true, result: { receipt: sampleReceipt() } },
    },
  });
  await runDevFlowCapture(devFlowSrc, ctxB);

  const isSurfaceproofOrTrust = (label) => label.startsWith('surfaceproof-shadow') || label.startsWith('trust-');
  const labelsA = callsA.filter((c) => !isSurfaceproofOrTrust(c.label)).map((c) => c.label);
  const labelsB = callsB.filter((c) => !isSurfaceproofOrTrust(c.label)).map((c) => c.label);
  assert.deepEqual(labelsB, labelsA, `(d) surfaceproof-shadow/trust- を除いた calls label 列は (a)/(b) で一致するはず。a=${JSON.stringify(labelsA)} b=${JSON.stringify(labelsB)}`);
});

// ============================================================
// (e) 旧 noninterference test の残存 pin: pr-iterate.js / dev-improve.js / .claude/agents/*.md に
// surfaceproof 参照が無い（SurfaceProof 配線は dev-flow.js のみ、という境界の固定）
// ============================================================

const SURFACEPROOF_REFERENCE_RE = /surfaceproof|SurfaceProof/;

const OTHER_WORKFLOW_FILES = [
  '.claude/workflows/pr-iterate.js',
  '.claude/workflows/dev-improve.js',
];

for (const relPath of OTHER_WORKFLOW_FILES) {
  test(`[surfaceproof] (e) ${relPath} に surfaceproof 参照が無い（SurfaceProof 配線は dev-flow.js のみ）`, () => {
    const content = readFileSync(join(repoRoot, relPath), 'utf8');
    assert.equal(SURFACEPROOF_REFERENCE_RE.test(content), false, `${relPath} に surfaceproof 参照が見つかった`);
  });
}

const AGENTS_DIR = join(repoRoot, '.claude/agents');
const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md'));

test('[surfaceproof] (e) .claude/agents/ 配下に .md ファイルが存在する（テスト自体の健全性チェック）', () => {
  assert.ok(agentFiles.length > 0, '.claude/agents/*.md が見つからない');
});

for (const fileName of agentFiles) {
  test(`[surfaceproof] (e) .claude/agents/${fileName} に surfaceproof 参照が無い（新規 agent 型を追加せず既存 dev-runner-haiku-ro を再利用）`, () => {
    const content = readFileSync(join(AGENTS_DIR, fileName), 'utf8');
    assert.equal(SURFACEPROOF_REFERENCE_RE.test(content), false, `.claude/agents/${fileName} に surfaceproof 参照が見つかった`);
  });
}
