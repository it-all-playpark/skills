// issue #411 (epic #390 Phase 3) F3: EvalSeal shadow wiring routing test。
//
// Phase 1 の _lib/trust-noninterference.test.mjs（「配線ゼロ」を固定する非干渉 guard）は、
// 本 task で意図どおり配線 routing test に置換される（同 test ファイル冒頭のコメント参照）。
// 本ファイルは dev-flow.js への EvalSeal (evalseal/1) shadow 配線
// （Evaluate 後 seal / Final reconcile 失効+再 seal / classifyMergeTier trustGate / summary /
// telemetry / return）が意図どおり行われ、shadow/off で既存挙動が変化しないことを実測する。
//
// ハーネスは makeRecordingSandbox（_lib/test-helpers/vm-sandbox.mjs）+ final-reconcile-
// routing.test.mjs / merge-tier-security-clearance-routing.test.mjs と同型のローカル
// runDevFlowCapture（{result, error} を返す）を使う。
//
// テストケース:
//   (a) repo が allowlist 不一致（省略）→ EVALSEAL_MODE='off' → trust-* 呼び出しゼロ +
//       journal-log prompt に 'trust_receipts' 無し + post-summary prompt に
//       'Trust receipts' 無し + return に trust_evalseal_mode 無し（AC-6 off 経路）
//   (b) repo=allowlist + runEval + trust-seal-eval ok:true → 'trust-seal-eval' が 1 回 +
//       journal-log telemetry の trust_receipts[0].verdict/record_integrity==='advisory' +
//       post-summary prompt に 'Trust receipts (shadow)' + merge_tier/reasons が (a) と同一
//       （shadow 非干渉）
//   (c) trust-seal-eval responder が null → run 完走・error null・trust キーなし（fail-open）
//   (d) fixes_applied>0 + finalReconcile reverified + trust-check-final が
//       check.verdict:'inconclusive'/reason_code:'DIGEST_MISMATCH' → evaluate entry が
//       telemetry 上 invalidated:true + 'trust-seal-final' が 'reconcile-sync' より後に呼ばれ
//       trust_receipts 2 件（AC-4）
//   (e) micro path（runEval=false）→ trust-* 呼び出しゼロ
//   (f) (a) と (b) の calls から 'trust-' 始まり label を除いた列が完全一致（AC-6 実測）
//   (g) 旧 noninterference test の残存 pin: pr-iterate.js / dev-improve.js /
//       .claude/agents/*.md に /trust-(schema|digest|mode|telemetry|wiring)|evalseal|EvalSeal/
//       参照が無い（EvalSeal 配線は dev-flow.js のみ、という境界の固定）

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

// ============================================================
// runDevFlowCapture: final-reconcile-routing.test.mjs / merge-tier-security-clearance-
// routing.test.mjs と同型のローカル copy（{result, error} を返す）
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

const ALLOWLISTED_REPO = 'it-all-playpark/skills';

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

// clean-micro（TRIVIAL && !runEval && dangerHits===[] → LITE 経路が発火し得る）
const MICRO_REQ = {
  summary: 'clean micro fix',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 1,
  breaking_change: false,
  breaking_keyword_scan: false,
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

// ============================================================
// createResponder: standard shape シナリオ (a)(b)(c)(d)(f) 共通の responder factory。
// overrides は label 単位（final-reconcile-routing.test.mjs の createResponder パターン踏襲）。
// repo:null/undefined は 'worktree' 応答から repo フィールドを省略（allowlist 不一致 → off）。
// ============================================================
function createResponder({ repo = null, req = STANDARD_REQ, overrides = {} } = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-411', ...(repo ? { repo } : {}) };
    if (label.startsWith('analyze')) return req;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (agentType === 'evaluator') return evaluatorResponseFor(req);
    // lite pr-review（micro clean 経路）は agentType 判定を label より先に置く
    // （lite-route-routing.test.mjs の precedent — 'pr-review-lite' も label.startsWith('pr') に一致するため）。
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
    // trust-* 系は overrides で明示指定しない限り応答しない（未知 label → null、fail-open の実測）
    if (label.startsWith('trust-')) return null;
    return null;
  };
}

function makeSandbox({ repo = null, req = STANDARD_REQ, overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder({ repo, req, overrides }), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '411',
  });
}

// journalCmd は payload を `<<'TELEMETRY_EOF'\n<json>\nTELEMETRY_EOF` heredoc として
// journal-log prompt に埋め込む（journal-handoff.mjs の JOURNAL_HANDOFF_DELIMITER）。
// prompt テキストから telemetry payload を JSON.parse して返す。見つからなければ null。
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

function sampleEnvelope({ stage, verdict = 'pass', receiptId, revisionDigest }) {
  return {
    run_id: `trust-1-${stage}aaaaaaaaaaaa`.slice(0, 25),
    layer: 'evalseal',
    mode: 'shadow',
    schema_version: 'evalseal/1',
    receipt_id: receiptId ?? `r-${stage}`,
    verdict,
    reason_code: 'OK',
    record_integrity: 'advisory',
    subject_kind: 'pull_request',
    subject_identity: '411',
    revision_digest: revisionDigest ?? `digest-${stage}`,
  };
}

function sampleReceipt({ stage, verdict = 'pass' }) {
  return {
    schema_version: 'evalseal/1',
    subject: { kind: 'pull_request', identity: '411', revision_digest: `digest-${stage}` },
    instrument: { adapter: 'dev-flow-evaluator', adapter_version: 'evalseal-seal/1', config_digest: 'bundle-digest', capabilities: ['tree-read'] },
    outcome: { verdict, reason_code: 'OK' },
    trust: { record_integrity: 'advisory' },
    anchors: { base_oid: 'base', head_oid: 'head', tree_oid: 'tree', bundle_digest: 'bundle-digest', evidence_digest: 'evidence-digest' },
    receipt_id: `r-${stage}`,
  };
}

// ============================================================
// (a) repo allowlist 不一致（省略）→ EVALSEAL_MODE='off' → trust-* 呼び出しゼロ + 各出力に
// trust キー無し（AC-6 off 経路）
// ============================================================

test('[evalseal] (a) repo が allowlist 不一致 → EVALSEAL_MODE=off → trust-* 呼び出しゼロ + journal/summary/return に trust キー無し', async () => {
  const { ctx, calls } = makeSandbox({ repo: null });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label.startsWith('trust-')), "(a) label が 'trust-' 始まりの呼び出しが存在してはならない");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(a) 'journal-log' の呼び出しが存在すること");
  assert.ok(!journalCall.prompt.includes('trust_receipts'), "(a) journal-log prompt に 'trust_receipts' が含まれてはならない");

  const summaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(summaryCall, "(a) 'post-summary' の呼び出しが存在すること");
  assert.ok(!summaryCall.prompt.includes('Trust receipts'), "(a) post-summary prompt に 'Trust receipts' が含まれてはならない");

  assert.equal(result?.trust_evalseal_mode, undefined, "(a) return に trust_evalseal_mode が含まれてはならない");
  assert.equal(result?.trust_receipts, undefined, "(a) return に trust_receipts が含まれてはならない");
});

// ============================================================
// (b) repo=allowlist + runEval + trust-seal-eval ok:true → trust-seal-eval 1 回 +
// telemetry trust_receipts[0].verdict/record_integrity==='advisory' + summary に
// 'Trust receipts (shadow)' + merge_tier/reasons が (a) と同一（shadow 非干渉）
// ============================================================

test('[evalseal] (b) repo=allowlist + trust-seal-eval ok → trust-seal-eval 1回 + telemetry advisory + summary 追記 + merge_tier 不変', async () => {
  const evalEnvelope = sampleEnvelope({ stage: 'evaluate' });
  const { ctx: ctxA } = makeSandbox({ repo: null });
  const { result: resultA } = await runDevFlowCapture(devFlowSrc, ctxA);

  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-seal-eval': { ok: true, mode: 'shadow', stage: 'evaluate', receipt: sampleReceipt({ stage: 'evaluate' }), envelope: evalEnvelope },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  const sealCalls = calls.filter((c) => c.label === 'trust-seal-eval');
  assert.equal(sealCalls.length, 1, `(b) 'trust-seal-eval' はちょうど 1 回呼ばれるはずだが ${sealCalls.length} 回だった`);

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(b) journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts;
  assert.equal(Array.isArray(receipts) && receipts.length, 1, `(b) telemetry.trust_receipts は 1 件のはずだが ${JSON.stringify(receipts)}`);
  assert.equal(receipts[0].verdict, 'pass', `(b) trust_receipts[0].verdict は 'pass' のはずだが ${receipts[0]?.verdict}`);
  assert.equal(receipts[0].record_integrity, 'advisory', `(b) trust_receipts[0].record_integrity は 'advisory' のはずだが ${receipts[0]?.record_integrity}`);
  assert.equal(receipts[0].stage, 'evaluate');
  assert.equal(receipts[0].invalidated, false);

  const summaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(summaryCall.prompt.includes('Trust receipts (shadow)'), "(b) post-summary prompt に 'Trust receipts (shadow)' が含まれるはず");

  assert.equal(result?.merge_tier, resultA?.merge_tier, `(b) merge_tier は (a) と同一のはずだが (a)=${resultA?.merge_tier} (b)=${result?.merge_tier}`);
  // vm.createContext は別 realm のため Array の deepEqual は prototype 差で構造比較が失敗し得る
  // （final-reconcile-routing.test.mjs 等の precedent どおり JSON.stringify で内容比較する）。
  assert.equal(
    JSON.stringify(result?.merge_tier_reasons),
    JSON.stringify(resultA?.merge_tier_reasons),
    '(b) merge_tier_reasons は (a) と同一のはず（shadow は既存 gate を変えない）',
  );
});

// ============================================================
// (c) trust-seal-eval responder が null → run 完走・error null・trust キーなし（fail-open）
// ============================================================

test('[evalseal] (c) trust-seal-eval が null → run 完走 + error null + trust キーなし（fail-open）', async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: { 'trust-seal-eval': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `(c) trust-seal-eval が null でも run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');
  assert.ok(calls.some((c) => c.label === 'trust-seal-eval'), "(c) 'trust-seal-eval' は呼ばれているはず（応答が null なだけ）");
  assert.equal(result?.trust_receipts, 0, `(c) trust_receipts は 0 のはずだが ${result?.trust_receipts}（受領物なし = 成功扱いしない）`);

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(!journalCall.prompt.includes('trust_receipts'), "(c) receipt が無いので journal-log prompt に 'trust_receipts' が含まれてはならない");
});

// ============================================================
// (d) fixes_applied>0 + finalReconcile reverified + trust-check-final が
// check.verdict:'inconclusive'/reason_code:'DIGEST_MISMATCH' → evaluate entry が telemetry 上
// invalidated:true + 'trust-seal-final' が 'reconcile-sync' より後に呼ばれ trust_receipts 2 件
// ============================================================

test("[evalseal] (d) fixes_applied>0 + trust-check-final DIGEST_MISMATCH → evaluate entry invalidated:true + trust-seal-final が reconcile-sync より後 + trust_receipts 2件", async () => {
  const finalEnvelope = sampleEnvelope({ stage: 'final', receiptId: 'r-final', revisionDigest: 'digest-final' });
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    fixesApplied: 1,
    overrides: {
      'trust-seal-eval': { ok: true, mode: 'shadow', stage: 'evaluate', receipt: sampleReceipt({ stage: 'evaluate' }), envelope: sampleEnvelope({ stage: 'evaluate' }) },
      'trust-check-final': { ok: true, mode: 'shadow', check: { verdict: 'inconclusive', reason_code: 'DIGEST_MISMATCH' } },
      'trust-seal-final': { ok: true, mode: 'shadow', stage: 'final', receipt: sampleReceipt({ stage: 'final' }), envelope: finalEnvelope },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  const idxSync = calls.findIndex((c) => c.label === 'reconcile-sync');
  const idxSealFinal = calls.findIndex((c) => c.label === 'trust-seal-final');
  const idxCheckFinal = calls.findIndex((c) => c.label === 'trust-check-final');
  assert.ok(idxSync >= 0, "(d) 'reconcile-sync' が呼ばれるはず");
  assert.ok(idxCheckFinal >= 0, "(d) 'trust-check-final' が呼ばれるはず");
  assert.ok(idxSealFinal >= 0, "(d) 'trust-seal-final' が呼ばれるはず");
  assert.ok(idxCheckFinal > idxSync, "(d) 'trust-check-final' は 'reconcile-sync' より後であるべき（Final PR HEAD 確定後）");
  assert.ok(idxSealFinal > idxSync, "(d) 'trust-seal-final' は 'reconcile-sync' より後であるべき（Final PR HEAD 確定後）");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(d) journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts;
  assert.equal(Array.isArray(receipts) && receipts.length, 2, `(d) trust_receipts は 2 件のはずだが ${JSON.stringify(receipts)}`);
  const evalEntry = receipts.find((r) => r.stage === 'evaluate');
  const finalEntry = receipts.find((r) => r.stage === 'final');
  assert.ok(evalEntry, "(d) stage='evaluate' の entry が存在するはず");
  assert.ok(finalEntry, "(d) stage='final' の entry が存在するはず");
  assert.equal(evalEntry.invalidated, true, `(d) evaluate entry は invalidated:true のはずだが ${JSON.stringify(evalEntry)}`);
  assert.equal(evalEntry.invalidated_reason, 'DIGEST_MISMATCH', `(d) evaluate entry の invalidated_reason は 'DIGEST_MISMATCH' のはずだが ${evalEntry.invalidated_reason}`);
  assert.equal(finalEntry.invalidated, false, "(d) final entry は invalidated:false のはず（新規 seal）");
});

// ============================================================
// (e) micro path（runEval=false）→ trust-* 呼び出しゼロ
// ============================================================

test('[evalseal] (e) micro path（runEval=false）→ trust-* 呼び出しゼロ（repo=allowlist でも obligation 実体が無いため seal しない）', async () => {
  const { ctx, calls } = makeSandbox({ repo: ALLOWLISTED_REPO, req: MICRO_REQ });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e');
  assert.ok(result !== null, '(e) workflow は return object を返すべきだが null だった');

  // 'trust-effectdelta-*'（issue #412, epic #390 Phase 4）は EFFECTDELTA_MODE 独立配線で
  // runEval と無関係に PR phase で発火するため、本 test の関心事（EvalSeal の runEval ゲート）
  // からは除外する（evalseal-routing (f) が surfaceproof-shadow を除外する precedent と同型）。
  assert.ok(!calls.some((c) => c.label.startsWith('trust-') && !c.label.startsWith('trust-effectdelta')), "(e) micro path（runEval=false）では EvalSeal 系 'trust-' 始まりの呼び出しが存在してはならない");
  // repo は allowlist のため EVALSEAL_MODE 自体は 'shadow'（mode 解決は runEval と独立）だが、
  // obligation の実体（evaluator 収束スナップショット）が無いため seal されず trust_receipts=0。
  assert.equal(result?.trust_receipts, 0, `(e) trust_receipts は 0 のはずだが ${result?.trust_receipts}（seal 自体が発生しない）`);
});

// ============================================================
// (f) (a) と (b) の calls から 'trust-' / 'surfaceproof-shadow' 始まり label を除いた列が完全一致
// （AC-6 実測。repoSlug allowlist は issue #410 SurfaceProof と共有のため、repo=allowlist に
// すると SurfaceProof 側の surfaceproof-shadow 呼び出しも同時に有効化される。これは
// issue #410 の非干渉領域であり本 test の関心事ではないため、比較対象から併せて除外する）。
// ============================================================

test("[evalseal] (f) (a)（off）と (b)（shadow）の calls 列は 'trust-'/'surfaceproof-shadow' 始まり label を除くと完全一致（非干渉実測）", async () => {
  const { ctx: ctxA, calls: callsA } = makeSandbox({ repo: null });
  await runDevFlowCapture(devFlowSrc, ctxA);

  const { ctx: ctxB, calls: callsB } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-seal-eval': { ok: true, mode: 'shadow', stage: 'evaluate', receipt: sampleReceipt({ stage: 'evaluate' }), envelope: sampleEnvelope({ stage: 'evaluate' }) },
    },
  });
  await runDevFlowCapture(devFlowSrc, ctxB);

  const isTrustOrSurfaceproof = (label) => label.startsWith('trust-') || label.startsWith('surfaceproof-shadow');
  const labelsA = callsA.filter((c) => !isTrustOrSurfaceproof(c.label)).map((c) => c.label);
  const labelsB = callsB.filter((c) => !isTrustOrSurfaceproof(c.label)).map((c) => c.label);
  assert.deepEqual(labelsB, labelsA, `(f) trust-/surfaceproof-shadow を除いた calls label 列は (a)/(b) で一致するはず。a=${JSON.stringify(labelsA)} b=${JSON.stringify(labelsB)}`);
});

// ============================================================
// (g) 旧 noninterference test の残存 pin: pr-iterate.js / dev-improve.js / .claude/agents/*.md に
// trust 参照が無い（EvalSeal 配線は dev-flow.js のみ、という境界の固定）
// ============================================================

const TRUST_REFERENCE_RE = /trust-(schema|digest|mode|telemetry|wiring)|evalseal|EvalSeal/;

const OTHER_WORKFLOW_FILES = [
  '.claude/workflows/pr-iterate.js',
  '.claude/workflows/dev-improve.js',
];

for (const relPath of OTHER_WORKFLOW_FILES) {
  test(`[evalseal] (g) ${relPath} に trust 参照が無い（EvalSeal 配線は dev-flow.js のみ）`, () => {
    const content = readFileSync(join(repoRoot, relPath), 'utf8');
    assert.equal(TRUST_REFERENCE_RE.test(content), false, `${relPath} に trust 参照が見つかった`);
  });
}

const AGENTS_DIR = join(repoRoot, '.claude/agents');
const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md'));

test('[evalseal] (g) .claude/agents/ 配下に .md ファイルが存在する（テスト自体の健全性チェック）', () => {
  assert.ok(agentFiles.length > 0, '.claude/agents/*.md が見つからない');
});

for (const fileName of agentFiles) {
  test(`[evalseal] (g) .claude/agents/${fileName} に trust 参照が無い`, () => {
    const content = readFileSync(join(AGENTS_DIR, fileName), 'utf8');
    assert.equal(TRUST_REFERENCE_RE.test(content), false, `.claude/agents/${fileName} に trust 参照が見つかった`);
  });
}
