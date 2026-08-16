// issue #411 (epic #390 Phase 3) F3: EvalSeal shadow wiring routing test。
// issue #471 (epic #390 Phase 6) で evalseal/2（機械導出 verdict）への移行に合わせて更新。
//
// Phase 1 の _lib/trust-noninterference.test.mjs（「配線ゼロ」を固定する非干渉 guard）は、
// 本 task で意図どおり配線 routing test に置換される（同 test ファイル冒頭のコメント参照）。
// 本ファイルは dev-flow.js への EvalSeal (evalseal/2) shadow 配線
// （Evaluate 後 seal(--evidence-file 付き) / Final reconcile 失効+asserted 組立 / Merge tier での
// trust-seal-final(riskFinal 由来 evidence bundle) / classifyMergeTier trustGate / summary /
// telemetry(trust_evalseal_missing_reason) / return）が意図どおり行われ、shadow/off で既存挙動が
// 変化しないことを実測する。
//
// ハーネスは makeRecordingSandbox（_lib/test-helpers/vm-sandbox.mjs）+ final-reconcile-
// routing.test.mjs / merge-tier-security-clearance-routing.test.mjs と同型のローカル
// runDevFlowCapture（{result, error} を返す）を使う。
//
// テストケース:
//   (a) repo が allowlist 不一致（省略）→ EVALSEAL_MODE='off' → trust-* 呼び出しゼロ +
//       journal-log prompt に 'trust_receipts'/'trust_evalseal_missing_reason' 無し +
//       post-summary prompt に 'Trust receipts' 無し + return に trust_evalseal_mode /
//       trust_evalseal_missing_reason 無し（AC-6 off 経路）
//   (b) repo=allowlist + runEval + trust-seal-eval ok:true → 'trust-seal-eval' が 1 回 +
//       prompt に --evidence-file / trust-evidence-eval.json Write 指示あり +
//       journal-log telemetry の trust_receipts[0].verdict/record_integrity==='advisory' +
//       trust_evalseal_missing_reason 無し + post-summary prompt に 'Trust receipts (shadow)' +
//       merge_tier/reasons が (a) と同一（shadow 非干渉）
//   (c) trust-seal-eval responder が null → run 完走・error null・trust_receipts=0 +
//       trust_evalseal_missing_reason='agent_null'（journal telemetry + return 両方。AC-6）
//   (c2) trust-seal-eval responder が {ok:false} → trust_evalseal_missing_reason='seal_error'
//   (c3) trust-seal-eval responder が {ok:true, mode:'off'} → trust_evalseal_missing_reason='mode_off'
//   (c4) trust-seal-eval responder が throw → trust_evalseal_missing_reason='agent_throw'
//   (d) fixes_applied>0 + finalReconcile reverified + trust-check-final が
//       check.verdict:'inconclusive'/reason_code:'DIGEST_MISMATCH' → evaluate entry が
//       telemetry 上 invalidated:true + 'trust-seal-final' が 'reconcile-sync' より後・
//       'danger-grep-final' 系より後に呼ばれ prompt に --evidence-file / trust-evidence-final.json
//       Write 指示あり + trust_receipts 2 件（AC-4）
//   (e) micro path（runEval=false）→ trust-* 呼び出しゼロ + trust_evalseal_missing_reason='eval_skipped'
//   (f) (a) と (b) の calls から 'trust-' 始まり label を除いた列が完全一致（AC-6 実測）
//   (g) 旧 noninterference test の残存 pin: pr-iterate.js / dev-improve.js /
//       .claude/agents/*.md に /trust-(schema|digest|mode|telemetry|wiring)|evalseal|EvalSeal/
//       参照が無い（EvalSeal 配線は dev-flow.js のみ、という境界の固定）
//   (h) issue #491 AC-2/AC-5: EffectDelta receipt はあるが EvalSeal receipt が無い run →
//       trust_evalseal_missing_reason='agent_null'（telemetry + return 両方）+ return
//       trust_receipts===0（EvalSeal 側は stage スコープで 0 件。EffectDelta receipt の有無に
//       非干渉）+ trust_effectdelta_pr_missing_reason キー無し + trust_run_id は出力される
//   (h2) issue #491 AC-3/AC-5: EvalSeal + EffectDelta 両方の receipt を持つ run →
//        trust_evalseal_missing_reason キーが telemetry/return どちらにも無い + return
//        trust_receipts===1（EvalSeal stage のみ、EffectDelta stage を含まない）
//   (h3) issue #491 AC-4: dev-flow.js ソースの静的 parity — gating spread 式が telemetry
//        handoff/return の 2 箇所に同一文字列で存在し、stage スコープ定義（evalsealStageReceipts）
//        が 1 箇所のみ、旧 layer 合算述語（state.trustReceipts.length===0 の gating 版）がコード上に
//        残っていないこと

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
  issue_number: 411,
  issue_title: 'stub-issue-title',
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
  issue_number: 411,
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
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    // trust-* 系は overrides で明示指定しない限り応答しない（未知 label → null、fail-open の実測）
    if (label.startsWith('trust-')) return null;
    if (label === 'issue-meta') return { ok: true, number: 411, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ repo = null, req = STANDARD_REQ, overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder({ repo, req, overrides }), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '411',
  });
}

// journal-save (stage1, issue #494) prompt から telemetry payload を JSON.parse して返す
// （journal-handoff.mjs の Write-tool verbatim delimiter <<<HANDOFF_DATA_BEGIN/END>>> から抽出。
// journal-log (stage2) はファイルパスのみを扱い payload literal を含まない）。
function extractTelemetryPayload(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/<<<HANDOFF_DATA_BEGIN>>>\n(\{[\s\S]*?\})\n<<<HANDOFF_DATA_END>>>/);
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
    schema_version: 'evalseal/2',
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
    schema_version: 'evalseal/2',
    subject: { kind: 'pull_request', identity: '411', revision_digest: `digest-${stage}` },
    instrument: { adapter: 'dev-flow-evaluator', adapter_version: 'evalseal-seal/2', config_digest: 'bundle-digest', capabilities: ['tree-read'] },
    outcome: { verdict, reason_code: 'OK' },
    trust: { record_integrity: 'advisory' },
    anchors: { base_oid: 'base', head_oid: 'head', tree_oid: 'tree', bundle_digest: 'bundle-digest', evidence_bundle_digest: 'sha256:' + '0'.repeat(64), asserted_digest: 'sha256:' + '1'.repeat(64) },
    receipt_id: `r-${stage}`,
  };
}

// EffectDelta 側 fixture (issue #491): 既存 sampleEnvelope/sampleReceipt は layer:'evalseal' 固定で
// (b)/(d) が使用中のため、衝突しない sampleEd* 名で layer:'effectdelta' 版を定義する。
function sampleEdEnvelope({ stage = 'pr', verdict = 'pass' } = {}) {
  return { run_id: `trust-1-${stage}aaaaaaaaaaaa`.slice(0, 25), layer: 'effectdelta', mode: 'shadow', schema_version: 'effectdelta/1', receipt_id: `r-ed-${stage}`, verdict, reason_code: 'OK', record_integrity: 'advisory', subject_kind: 'pull_request', subject_identity: '411', revision_digest: `digest-ed-${stage}` };
}
function sampleEdReceipt({ stage = 'pr', verdict = 'pass' } = {}) {
  return { schema_version: 'effectdelta/1', subject: { kind: 'pull_request', identity: '411', revision_digest: `digest-ed-${stage}` }, instrument: { adapter: 'effectdelta-github', adapter_version: '1.0.0', config_digest: 'config-digest', capabilities: ['gh-write-once'] }, outcome: { verdict, reason_code: 'OK' }, trust: { record_integrity: 'advisory' }, anchors: { effect_id: `effect-${stage}` }, receipt_id: `r-ed-${stage}` };
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

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, "(a) 'journal-log' の呼び出しが存在すること");
  assert.ok(!journalCall.prompt.includes('trust_receipts'), "(a) journal-log prompt に 'trust_receipts' が含まれてはならない");
  assert.ok(!journalCall.prompt.includes('trust_evalseal_missing_reason'), "(a) journal-log prompt に 'trust_evalseal_missing_reason' が含まれてはならない（EVALSEAL_MODE=off）");

  const summaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(summaryCall, "(a) 'post-summary' の呼び出しが存在すること");
  assert.ok(!summaryCall.prompt.includes('Trust receipts'), "(a) post-summary prompt に 'Trust receipts' が含まれてはならない");

  assert.equal(result?.trust_evalseal_mode, undefined, "(a) return に trust_evalseal_mode が含まれてはならない");
  assert.equal(result?.trust_receipts, undefined, "(a) return に trust_receipts が含まれてはならない");
  assert.equal(result?.trust_evalseal_missing_reason, undefined, "(a) return に trust_evalseal_missing_reason が含まれてはならない");
});

// ============================================================
// (b) repo=allowlist + runEval + trust-seal-eval ok:true → trust-seal-eval 1 回 +
// prompt に --evidence-file 付き + telemetry trust_receipts[0].verdict/record_integrity==='advisory' +
// summary に 'Trust receipts (shadow)' + merge_tier/reasons が (a) と同一（shadow 非干渉）
// ============================================================

test('[evalseal] (b) repo=allowlist + trust-seal-eval ok → trust-seal-eval 1回(--evidence-file付き) + telemetry advisory + summary 追記 + merge_tier 不変', async () => {
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
  assert.ok(sealCalls[0].prompt.includes('--evidence-file'), "(b) trust-seal-eval prompt に '--evidence-file' が含まれるはず");
  assert.ok(sealCalls[0].prompt.includes('trust-evidence-eval.json'), "(b) trust-seal-eval prompt に 'trust-evidence-eval.json' への Write 指示が含まれるはず");

  const journalCall = calls.find((c) => c.label === 'journal-save');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(b) journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts;
  assert.equal(Array.isArray(receipts) && receipts.length, 1, `(b) telemetry.trust_receipts は 1 件のはずだが ${JSON.stringify(receipts)}`);
  assert.equal(receipts[0].verdict, 'pass', `(b) trust_receipts[0].verdict は 'pass' のはずだが ${receipts[0]?.verdict}`);
  assert.equal(receipts[0].record_integrity, 'advisory', `(b) trust_receipts[0].record_integrity は 'advisory' のはずだが ${receipts[0]?.record_integrity}`);
  assert.equal(receipts[0].stage, 'evaluate');
  assert.equal(receipts[0].invalidated, false);
  assert.equal(payload?.telemetry?.trust_evalseal_missing_reason, undefined, "(b) receipt が 1 件あるので telemetry に trust_evalseal_missing_reason が含まれてはならない");
  assert.equal(result?.trust_evalseal_missing_reason, undefined, '(b) return に trust_evalseal_missing_reason が含まれてはならない');

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
// (c) trust-seal-eval responder が null → run 完走・error null・trust_receipts=0 +
// trust_evalseal_missing_reason='agent_null'（AC-6）
// ============================================================

test("[evalseal] (c) trust-seal-eval が null → run 完走 + error null + trust_receipts=0 + missing_reason='agent_null'（fail-open）", async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: { 'trust-seal-eval': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `(c) trust-seal-eval が null でも run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');
  assert.ok(calls.some((c) => c.label === 'trust-seal-eval'), "(c) 'trust-seal-eval' は呼ばれているはず（応答が null なだけ）");
  assert.equal(result?.trust_receipts, 0, `(c) trust_receipts は 0 のはずだが ${result?.trust_receipts}（受領物なし = 成功扱いしない）`);
  assert.equal(result?.trust_evalseal_missing_reason, 'agent_null', `(c) trust_evalseal_missing_reason は 'agent_null' のはずだが ${result?.trust_evalseal_missing_reason}`);

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(!journalCall.prompt.includes('"trust_receipts"'), "(c) receipt が無いので journal-log prompt に 'trust_receipts' キーが含まれてはならない");
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.equal(payload?.telemetry?.trust_evalseal_missing_reason, 'agent_null', "(c) journal telemetry の trust_evalseal_missing_reason は 'agent_null' のはず");
});

// ============================================================
// (c2)(c3)(c4) missing_reason の他分岐（seal_error / mode_off / agent_throw）
// ============================================================

test("[evalseal] (c2) trust-seal-eval が {ok:false} → missing_reason='seal_error'", async () => {
  const { ctx } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: { 'trust-seal-eval': { ok: false, mode: 'shadow', error: 'boom' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c2');
  assert.equal(result?.trust_evalseal_missing_reason, 'seal_error', `(c2) missing_reason は 'seal_error' のはずだが ${result?.trust_evalseal_missing_reason}`);
});

test("[evalseal] (c3) trust-seal-eval が {ok:true, mode:'off'} → missing_reason='mode_off'", async () => {
  const { ctx } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: { 'trust-seal-eval': { ok: true, mode: 'off' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c3');
  assert.equal(result?.trust_evalseal_missing_reason, 'mode_off', `(c3) missing_reason は 'mode_off' のはずだが ${result?.trust_evalseal_missing_reason}`);
});

test("[evalseal] (c4) trust-seal-eval responder が throw → missing_reason='agent_throw'", async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-seal-eval': () => {
        throw new Error('boom-throw');
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c4');
  assert.ok(result !== null, '(c4) workflow は return object を返すべきだが null だった（例外が run 全体を落としてはならない）');
  assert.ok(calls.some((c) => c.label === 'trust-seal-eval'), "(c4) 'trust-seal-eval' は呼ばれているはず");
  assert.equal(result?.trust_evalseal_missing_reason, 'agent_throw', `(c4) missing_reason は 'agent_throw' のはずだが ${result?.trust_evalseal_missing_reason}`);
});

// ============================================================
// (d) fixes_applied>0 + finalReconcile reverified + trust-check-final が
// check.verdict:'inconclusive'/reason_code:'DIGEST_MISMATCH' → evaluate entry が telemetry 上
// invalidated:true + 'trust-seal-final' が 'reconcile-sync'/danger-grep-final 系より後に呼ばれ
// --evidence-file 付き + trust_receipts 2 件
// ============================================================

test("[evalseal] (d) fixes_applied>0 + trust-check-final DIGEST_MISMATCH → evaluate entry invalidated:true + trust-seal-final(Merge tier, --evidence-file付き)が reconcile-sync より後 + trust_receipts 2件", async () => {
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
  assert.ok(idxSealFinal > idxSync, "(d) 'trust-seal-final' は 'reconcile-sync' より後であるべき（Final PR HEAD 確定後、Merge tier phase へ移設。issue #471）");
  assert.ok(idxSealFinal > idxCheckFinal, "(d) 'trust-seal-final' は 'trust-check-final' より後であるべき（Final reconcile → Merge tier の順）");

  const sealFinalCall = calls[idxSealFinal];
  assert.ok(sealFinalCall.prompt.includes('--evidence-file'), "(d) trust-seal-final prompt に '--evidence-file' が含まれるはず");
  assert.ok(sealFinalCall.prompt.includes('trust-evidence-final.json'), "(d) trust-seal-final prompt に 'trust-evidence-final.json' への Write 指示が含まれるはず");
  assert.ok(sealFinalCall.prompt.includes('--tree-source head'), "(d) trust-seal-final prompt に '--tree-source head' が含まれるはず");

  const journalCall = calls.find((c) => c.label === 'journal-save');
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
  assert.equal(payload?.telemetry?.trust_evalseal_missing_reason, undefined, '(d) receipt が 2 件あるので telemetry に trust_evalseal_missing_reason が含まれてはならない');
});

// ============================================================
// (e) micro path（runEval=false）→ trust-* 呼び出しゼロ + trust_evalseal_missing_reason='eval_skipped'
// ============================================================

test("[evalseal] (e) micro path（runEval=false）→ trust-* 呼び出しゼロ + missing_reason='eval_skipped'（repo=allowlist でも obligation 実体が無いため seal しない）", async () => {
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
  assert.equal(result?.trust_evalseal_missing_reason, 'eval_skipped', `(e) trust_evalseal_missing_reason は 'eval_skipped' のはずだが ${result?.trust_evalseal_missing_reason}`);
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

// ============================================================
// (h) issue #491 AC-2/AC-5: EffectDelta receipt はあるが EvalSeal receipt が無い run →
// trust_evalseal_missing_reason は EffectDelta receipt の有無に非干渉のまま 'agent_null' を出力し、
// return trust_receipts は EvalSeal stage スコープの 0 件になる
// ============================================================

test("[evalseal] (h) EffectDelta receipt のみ（EvalSeal receipt 無し）→ trust_evalseal_missing_reason='agent_null' + trust_receipts=0（EvalSeal 側は非干渉）", async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleEdReceipt({ stage: 'pr' }), envelope: sampleEdEnvelope({ stage: 'pr' }) },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h');
  assert.equal(error, null, `(h) run が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(h) workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, "(h) 'journal-log' の呼び出しが存在すること");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, '(h) journal-log prompt から telemetry payload を JSON.parse できるはず');

  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(receipts.some((r) => r.stage === 'pr' && r.layer === 'effectdelta'), "(h) telemetry.trust_receipts に stage:'pr'/layer:'effectdelta' の entry が存在するはず");
  assert.ok(!receipts.some((r) => r.layer === 'evalseal'), "(h) telemetry.trust_receipts に layer:'evalseal' の entry が含まれてはならない");

  assert.equal(payload?.telemetry?.trust_evalseal_missing_reason, 'agent_null', `(h) telemetry.trust_evalseal_missing_reason は 'agent_null' のはずだが ${payload?.telemetry?.trust_evalseal_missing_reason}`);
  assert.equal(result?.trust_evalseal_missing_reason, 'agent_null', `(h) return.trust_evalseal_missing_reason は 'agent_null' のはずだが ${result?.trust_evalseal_missing_reason}`);
  assert.equal(result?.trust_receipts, 0, `(h) return.trust_receipts は EvalSeal stage スコープで 0 のはずだが ${result?.trust_receipts}`);

  assert.ok(payload?.telemetry?.trust_run_id, "(h) EffectDelta receipt があるので telemetry.trust_run_id は出力されるはず（union 判定は不変）");
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload?.telemetry ?? {}, 'trust_effectdelta_pr_missing_reason'),
    false,
    '(h) EffectDelta 側は receipt があるので trust_effectdelta_pr_missing_reason キーが存在してはならない（非干渉）',
  );
});

// ============================================================
// (h2) issue #491 AC-3/AC-5: EvalSeal + EffectDelta 両方の receipt を持つ run →
// trust_evalseal_missing_reason キーが telemetry/return どちらにも無く、trust_receipts は
// EvalSeal stage のみの件数（=1）になる
// ============================================================

test('[evalseal] (h2) EvalSeal + EffectDelta 両方の receipt あり → trust_evalseal_missing_reason キー無し + trust_receipts=1（EvalSeal stage のみ）', async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-seal-eval': { ok: true, mode: 'shadow', stage: 'evaluate', receipt: sampleReceipt({ stage: 'evaluate' }), envelope: sampleEnvelope({ stage: 'evaluate' }) },
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleEdReceipt({ stage: 'pr' }), envelope: sampleEdEnvelope({ stage: 'pr' }) },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h2');
  assert.ok(result !== null, '(h2) workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-save');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(h2) journal-log prompt から telemetry payload を JSON.parse できるはず');

  assert.equal(
    Object.prototype.hasOwnProperty.call(payload?.telemetry ?? {}, 'trust_evalseal_missing_reason'),
    false,
    '(h2) EvalSeal receipt があるので telemetry.trust_evalseal_missing_reason キーが存在してはならない',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result ?? {}, 'trust_evalseal_missing_reason'),
    false,
    '(h2) return にも trust_evalseal_missing_reason キーが存在してはならない',
  );
  assert.equal(result?.trust_receipts, 1, `(h2) return.trust_receipts は EvalSeal stage のみで 1 のはずだが ${result?.trust_receipts}`);

  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.equal(receipts.filter((r) => r.layer === 'evalseal').length, 1, "(h2) telemetry.trust_receipts の layer:'evalseal' entry は 1 件のはず");
  assert.equal(receipts.filter((r) => r.layer === 'effectdelta').length, 1, "(h2) telemetry.trust_receipts の layer:'effectdelta' entry は 1 件のはず");
});

// ============================================================
// (h3) issue #491 AC-4: 静的 parity — telemetry handoff / return の gating spread 式が同一
// 文字列で 2 箇所にあり、stage スコープ定義が 1 箇所のみ、旧 layer 合算 gating 述語が残っていない
// ============================================================

test('[evalseal] (h3) dev-flow.js ソースに evalsealStageReceipts スコープの gating が handoff/return の2箇所に同一文字列であり、旧 layer 合算述語が残っていない', () => {
  const gatingRe = /\.\.\.\(EVALSEAL_MODE !== 'off' && evalsealStageReceipts\.length === 0 \? \{ trust_evalseal_missing_reason: TRUST_EVALSEAL_MISSING_REASONS\.includes\(state\.trustEvalsealMissingReason\) \? state\.trustEvalsealMissingReason : 'unknown' \} : \{\}\)/g;
  const gatingMatches = devFlowSrc.match(gatingRe) ?? [];
  assert.equal(gatingMatches.length, 2, `evalsealStageReceipts スコープの gating spread 式は telemetry handoff と return の2箇所にあるはずだが ${gatingMatches.length} 箇所だった`);

  const defRe = /const evalsealStageReceipts = state\.trustReceipts\.filter\(\(r\) => r\.stage === 'evaluate' \|\| r\.stage === 'final'\)/g;
  const defMatches = devFlowSrc.match(defRe) ?? [];
  assert.equal(defMatches.length, 1, `evalsealStageReceipts の定義は1箇所のみのはずだが ${defMatches.length} 箇所だった`);

  const staleRe = /\.\.\.\(EVALSEAL_MODE !== 'off' && state\.trustReceipts\.length === 0/g;
  const staleMatches = devFlowSrc.match(staleRe) ?? [];
  assert.equal(staleMatches.length, 0, `旧 layer 合算 gating 述語（state.trustReceipts.length===0）がコード上に残ってはならないが ${staleMatches.length} 箇所見つかった`);
});
