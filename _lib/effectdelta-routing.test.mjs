// issue #412 (epic #390 Phase 4) F4: EffectDelta shadow wiring routing test。
//
// 本ファイルは dev-flow.js への EffectDelta (effectdelta/1) shadow 配線
// （PR phase 直後の read-only pr-observe / post-summary の comment-ensure + gh pr comment
// fallback / telemetry / return）が意図どおり行われ、off/shadow で既存挙動（req/shape/
// merge_tier）が変化しないことを実測する。
//
// ハーネスは makeRecordingSandbox（_lib/test-helpers/vm-sandbox.mjs）+ evalseal-routing.test.mjs /
// surfaceproof-routing.test.mjs と同型のローカル runDevFlowCapture（{result, error} を返す）を使う。
//
// テストケース:
//   (i)   EFFECTDELTA_MODE の resolveLayerMode 解決（dev-flow.js ソースの静的確認）
//   (a)   repo が allowlist 不一致（省略）→ EFFECTDELTA_MODE='off' → trust-effectdelta-pr /
//         post-summary(shadow) 呼び出しゼロ + journal-log prompt に 'trust_receipts' 系
//         effectdelta stage 無し（AC-15 off 経路）
//   (b)   repo=allowlist + pr-observe ok:true → 'trust-effectdelta-pr' が 1 回、PR 作成
//         （'pr#'始まり label）より後に呼ばれる + journal telemetry の trust_receipts に
//         stage:'pr' entry + merge_tier/reasons が (a) と同一（shadow 非干渉）
//   (ii)  呼び出しパスが `${WT}/_shared/scripts/effectdelta-github.sh`（installed パス不使用）
//   (c)   pr-observe responder が null → run 完走・error null・trust_receipts に stage:'pr' 無し
//         （fail-open）
//   (iii) post-summary shadow prompt に fallback 指示（`gh pr comment` + `--body-file`）が含まれる
//   (iv)  off 経路の post-summary prompt が現行文字列を保持（byte 単位不変）
//   (d)   shadow + comment-ensure ok:true → journal telemetry の trust_receipts に
//         stage:'summary-comment' entry + domain_reason_code passthrough
//   (e)   telemetry mapping に domain_reason_code passthrough が存在（静的確認 + 実測）
//   (v)   PR 作成 agent 呼び出し（git-pr skill 経由、label 'pr#...'）が off/shadow で不変
//   (f)   (a) と (b) の calls から 'trust-effectdelta' 始まり label を除いた列が完全一致
//         （AC-15 実測）
//   (g)   旧 precedent の pin: pr-iterate.js / dev-improve.js / .claude/agents/*.md に
//         effectdelta/EffectDelta 参照が無い（EffectDelta 配線は dev-flow.js のみ、
//         という境界の固定）

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

// runDevFlowCapture: evalseal-routing.test.mjs / surfaceproof-routing.test.mjs と同型のローカル
// copy（{result, error} を返す）。
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

// journal-log prompt から telemetry payload を JSON.parse して返す（journal-handoff.mjs の
// heredoc delimiter を経由。見つからなければ null）。
// journal-handoff.mjs (issue #412 F3: atomic mktemp/mv write) の heredoc は
// `<<'TELEMETRY_EOF' && __jh_id=... && mv -f ...` のように delimiter 直後にシェルコマンドが
// 続くため、payload（JSON.stringify、常に単一行・`{`始まり）を挟む 2 個の改行のうち前者直後
// から `\nTELEMETRY_EOF` 直前までを取り出す。
function extractTelemetryPayload(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/\n(\{[\s\S]*?\})\nTELEMETRY_EOF/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// createResponder: standard shape シナリオ共通の responder factory（evalseal-routing.test.mjs /
// surfaceproof-routing.test.mjs の createResponder と同型）。overrides は label 単位。
// repo:null/undefined は 'worktree' 応答から repo フィールドを省略（allowlist 不一致 → off）。
function createResponder({ repo = null, req = STANDARD_REQ, overrides = {} } = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-412', ...(repo ? { repo } : {}) };
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
    // trust-effectdelta-* / post-summary は override で明示指定しない限り応答しない
    // （未知 label → null、fail-open の実測）ため 'pr' 始まり判定より先に置く必要は無い
    // （'trust-effectdelta-pr' は 'pr' で始まらない）。
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
    return null;
  };
}

function makeSandbox({ repo = null, req = STANDARD_REQ, overrides = {}, fixesApplied = 0 } = {}) {
  const { ctx, calls } = makeRecordingSandbox(createResponder({ repo, req, overrides }), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: '412',
  });
  return { ctx, calls };
}

function sampleEnvelope({ stage, verdict = 'pass' } = {}) {
  return {
    run_id: `trust-1-${stage}aaaaaaaaaaaa`.slice(0, 25),
    layer: 'effectdelta',
    mode: 'shadow',
    schema_version: 'effectdelta/1',
    receipt_id: `r-${stage}`,
    verdict,
    reason_code: 'OK',
    record_integrity: 'advisory',
    subject_kind: 'pull_request',
    subject_identity: '412',
    revision_digest: `digest-${stage}`,
  };
}

function sampleReceipt({ stage, verdict = 'pass' } = {}) {
  return {
    schema_version: 'effectdelta/1',
    subject: { kind: 'pull_request', identity: '412', revision_digest: `digest-${stage}` },
    instrument: { adapter: 'effectdelta-github', adapter_version: '1.0.0', config_digest: 'config-digest', capabilities: ['gh-write-once'] },
    outcome: { verdict, reason_code: 'OK' },
    trust: { record_integrity: 'advisory' },
    anchors: { effect_id: `effect-${stage}` },
    receipt_id: `r-${stage}`,
  };
}

// ============================================================
// (i) EFFECTDELTA_MODE の resolveLayerMode 解決が存在（静的確認）
// ============================================================

test("[effectdelta] (i) dev-flow.js が EFFECTDELTA_MODE を resolveLayerMode({layer:'effectdelta',...}) で解決している", () => {
  assert.match(
    devFlowSrc,
    /const EFFECTDELTA_MODE = resolveLayerMode\(\{\s*layer:\s*'effectdelta'/,
    'EFFECTDELTA_MODE の resolveLayerMode 解決が見つからない',
  );
});

// ============================================================
// (a) repo が allowlist 不一致 → EFFECTDELTA_MODE=off → trust-effectdelta-pr / post-summary(shadow)
// 呼び出しゼロ + journal に effectdelta stage 無し（AC-15 off 経路）
// ============================================================

test('[effectdelta] (a) repo が allowlist 不一致 → EFFECTDELTA_MODE=off → trust-effectdelta-pr 呼び出しゼロ + journal に effectdelta stage 無し', async () => {
  const { ctx, calls } = makeSandbox({ repo: null });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label.startsWith('trust-effectdelta')), "(a) label が 'trust-effectdelta' 始まりの呼び出しが存在してはならない");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall, "(a) 'journal-log' の呼び出しが存在すること");
  const payload = extractTelemetryPayload(journalCall.prompt);
  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(!receipts.some((r) => r.stage === 'pr' || r.stage === 'summary-comment'), "(a) trust_receipts に effectdelta stage（'pr'/'summary-comment'）が含まれてはならない");
});

// ============================================================
// (b) repo=allowlist + pr-observe ok:true → trust-effectdelta-pr 1 回・PR 作成より後 +
// telemetry に stage:'pr' entry + merge_tier 不変（shadow 非干渉）
// ============================================================

test("[effectdelta] (b) repo=allowlist + pr-observe ok → 'trust-effectdelta-pr' 1回・PR作成より後 + telemetry stage:'pr' + merge_tier 不変", async () => {
  const { ctx: ctxA, calls: callsA } = makeSandbox({ repo: null });
  const { result: resultA } = await runDevFlowCapture(devFlowSrc, ctxA);

  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }) },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  const prObserveCalls = calls.filter((c) => c.label === 'trust-effectdelta-pr');
  assert.equal(prObserveCalls.length, 1, `(b) 'trust-effectdelta-pr' はちょうど 1 回呼ばれるはずだが ${prObserveCalls.length} 回だった`);

  const idxPrCreate = calls.findIndex((c) => c.label.startsWith('pr#'));
  const idxPrObserve = calls.findIndex((c) => c.label === 'trust-effectdelta-pr');
  assert.ok(idxPrCreate >= 0, "(b) PR 作成呼び出し（label 'pr#...'）が存在するはず");
  assert.ok(idxPrObserve > idxPrCreate, "(b) 'trust-effectdelta-pr' は PR 作成呼び出しより後であるべき（作成後の read-only 観測）");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(b) journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts ?? [];
  const prEntry = receipts.find((r) => r.stage === 'pr');
  assert.ok(prEntry, "(b) trust_receipts に stage:'pr' の entry が存在するはず");
  assert.equal(prEntry.verdict, 'pass');
  assert.equal(prEntry.invalidated, false);

  assert.equal(result?.merge_tier, resultA?.merge_tier, `(b) merge_tier は (a) と同一のはずだが (a)=${resultA?.merge_tier} (b)=${result?.merge_tier}`);
  assert.equal(
    JSON.stringify(result?.merge_tier_reasons),
    JSON.stringify(resultA?.merge_tier_reasons),
    '(b) merge_tier_reasons は (a) と同一のはず（shadow は既存 gate を変えない）',
  );
});

// ============================================================
// (ii) 呼び出しパスが ${WT}/_shared/scripts/effectdelta-github.sh（installed パス不使用）
// ============================================================

test('[effectdelta] (ii) pr-observe / post-summary(shadow) prompt は worktree パス（${WT}/_shared/scripts/effectdelta-github.sh）を使い、installed パス（~/.claude/skills/...）を使わない', async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }) },
      'post-summary': { ok: true, posted: true, method: 'comment-ensure', mode: 'shadow', receipt: sampleReceipt({ stage: 'summary-comment' }), envelope: sampleEnvelope({ stage: 'summary-comment' }) },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'ii');

  const prObserveCall = calls.find((c) => c.label === 'trust-effectdelta-pr');
  assert.ok(prObserveCall, "(ii) 'trust-effectdelta-pr' 呼び出しが存在するはず");
  assert.match(prObserveCall.prompt, /\/_shared\/scripts\/effectdelta-github\.sh pr-observe/, "(ii) pr-observe prompt に worktree パスの effectdelta-github.sh 呼び出しが含まれるはず");
  assert.doesNotMatch(prObserveCall.prompt, /~\/\.claude\/skills\/.*effectdelta-github\.sh/, '(ii) pr-observe prompt は installed パスを使ってはならない');

  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall, "(ii) 'post-summary' 呼び出しが存在するはず");
  assert.match(postSummaryCall.prompt, /\/_shared\/scripts\/effectdelta-github\.sh comment-ensure/, "(ii) post-summary(shadow) prompt に worktree パスの effectdelta-github.sh comment-ensure 呼び出しが含まれるはず");
  assert.doesNotMatch(postSummaryCall.prompt, /~\/\.claude\/skills\/.*effectdelta-github\.sh/, '(ii) post-summary(shadow) prompt は installed パスを使ってはならない');
});

// ============================================================
// (c) pr-observe responder が null → run 完走・error null・trust_receipts に stage:'pr' 無し
// （fail-open）
// ============================================================

test("[effectdelta] (c) trust-effectdelta-pr が null → run 完走 + error null + trust_receipts に stage:'pr' 無し（fail-open）", async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: { 'trust-effectdelta-pr': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `(c) trust-effectdelta-pr が null でも run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');
  assert.ok(calls.some((c) => c.label === 'trust-effectdelta-pr'), "(c) 'trust-effectdelta-pr' は呼ばれているはず（応答が null なだけ）");

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(!receipts.some((r) => r.stage === 'pr'), "(c) receipt が無いので trust_receipts に stage:'pr' entry が含まれてはならない");
});

// ============================================================
// (iii) post-summary shadow prompt に fallback 指示（gh pr comment + --body-file）が含まれる
// ============================================================

test("[effectdelta] (iii) post-summary(shadow) prompt に fallback 指示（'gh pr comment' + '--body-file'）が含まれる", async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'post-summary': { ok: true, posted: true, method: 'gh-pr-comment-fallback', mode: 'off' },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'iii');

  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall, "(iii) 'post-summary' 呼び出しが存在するはず");
  assert.match(postSummaryCall.prompt, /gh pr comment/, "(iii) post-summary(shadow) prompt に 'gh pr comment' fallback 指示が含まれるはず");
  assert.match(postSummaryCall.prompt, /--body-file/, "(iii) post-summary(shadow) prompt に '--body-file' が含まれるはず");
});

// ============================================================
// (iv) off 経路の post-summary prompt が現行文字列を保持（byte 単位不変）
// ============================================================

test('[effectdelta] (iv) off 経路（repo allowlist 不一致）の post-summary prompt は現行文字列（gh pr comment 直接実行）を保持する', async () => {
  const { ctx, calls } = makeSandbox({ repo: null });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'iv');

  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall, "(iv) 'post-summary' 呼び出しが存在するはず");
  assert.match(postSummaryCall.prompt, /保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: `gh pr comment \d+ --body-file <BODY_FILE>`/, '(iv) off 経路の prompt に既存の直接 gh pr comment 指示が含まれるはず');
  assert.doesNotMatch(postSummaryCall.prompt, /effectdelta-github\.sh/, '(iv) off 経路の prompt に effectdelta-github.sh への言及があってはならない（byte 不変）');
});

// ============================================================
// (d) shadow + comment-ensure ok:true → telemetry の trust_receipts に stage:'summary-comment'
// entry + domain_reason_code passthrough
// ============================================================

test("[effectdelta] (d) shadow + comment-ensure ok → trust_receipts に stage:'summary-comment' + domain_reason_code", async () => {
  const { ctx, calls } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'post-summary': {
        ok: true, posted: true, url: 'http://x', mode: 'shadow', effect_id: 'effect-summary',
        observation: { status: 'observed', reason_code: 'DUPLICATE_EFFECT' },
        receipt: sampleReceipt({ stage: 'summary-comment' }),
        envelope: sampleEnvelope({ stage: 'summary-comment' }),
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-log');
  const payload = extractTelemetryPayload(journalCall?.prompt);
  assert.ok(payload, '(d) journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts ?? [];
  const summaryEntry = receipts.find((r) => r.stage === 'summary-comment');
  assert.ok(summaryEntry, "(d) trust_receipts に stage:'summary-comment' の entry が存在するはず");
  assert.equal(summaryEntry.domain_reason_code, 'DUPLICATE_EFFECT', `(d) domain_reason_code は 'DUPLICATE_EFFECT' のはずだが ${summaryEntry.domain_reason_code}`);
});

// ============================================================
// (e) telemetry mapping に domain_reason_code passthrough が存在（静的確認）
// ============================================================

test('[effectdelta] (e) dev-flow.js の trust_receipts telemetry mapping に domain_reason_code passthrough が存在する', () => {
  assert.match(
    devFlowSrc,
    /r\.domain_reason_code \? \{ domain_reason_code: r\.domain_reason_code \} : \{\}/,
    'trust_receipts mapping に domain_reason_code の conditional spread passthrough が見つからない',
  );
});

// ============================================================
// (v) PR 作成 agent 呼び出し（git-pr skill 経由、label 'pr#...'）が off/shadow で不変
// ============================================================

test("[effectdelta] (v) PR 作成呼び出し（label 'pr#...', git-pr skill 経由）の prompt は off/shadow で不変", async () => {
  const { ctx: ctxA, calls: callsA } = makeSandbox({ repo: null });
  await runDevFlowCapture(devFlowSrc, ctxA);
  const { ctx: ctxB, calls: callsB } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }) },
    },
  });
  await runDevFlowCapture(devFlowSrc, ctxB);

  const prCallA = callsA.find((c) => c.label.startsWith('pr#'));
  const prCallB = callsB.find((c) => c.label.startsWith('pr#'));
  assert.ok(prCallA && prCallB, "(v) 両シナリオで 'pr#...' 呼び出しが存在するはず");
  assert.equal(prCallB.prompt, prCallA.prompt, "(v) PR 作成呼び出しの prompt は off/shadow で byte 単位不変であるべき");
  assert.match(prCallA.prompt, /Skill: git-pr/, "(v) PR 作成 prompt に 'Skill: git-pr' が含まれるはず");
});

// ============================================================
// (f) (a) と (b) の calls から 'trust-'/'surfaceproof-shadow' 始まり label を除いた列が完全一致
// （AC-15 実測。repoSlug allowlist は SurfaceProof/EvalSeal と共有のため、repo=allowlist に
// すると他 layer の shadow 呼び出しも同時に有効化される。これは issue #410/#411 の非干渉領域
// であり本 test の関心事ではないため、比較対象から併せて除外する — evalseal-routing (f) /
// surfaceproof-routing (d) と同じ precedent）。
// ============================================================

test("[effectdelta] (f) (a)（off）と (b)（shadow）の calls 列は 'trust-'/'surfaceproof-shadow' 始まり label を除くと完全一致（非干渉実測）", async () => {
  const { ctx: ctxA, calls: callsA } = makeSandbox({ repo: null });
  await runDevFlowCapture(devFlowSrc, ctxA);

  const { ctx: ctxB, calls: callsB } = makeSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }) },
    },
  });
  await runDevFlowCapture(devFlowSrc, ctxB);

  const isTrustOrSurfaceproof = (label) => label.startsWith('trust-') || label.startsWith('surfaceproof-shadow');
  const labelsA = callsA.filter((c) => !isTrustOrSurfaceproof(c.label)).map((c) => c.label);
  const labelsB = callsB.filter((c) => !isTrustOrSurfaceproof(c.label)).map((c) => c.label);
  assert.deepEqual(labelsB, labelsA, `(f) trust-/surfaceproof-shadow を除いた calls label 列は (a)/(b) で一致するはず。a=${JSON.stringify(labelsA)} b=${JSON.stringify(labelsB)}`);
});

// ============================================================
// (g) 旧 precedent の pin: pr-iterate.js / dev-improve.js / .claude/agents/*.md に
// effectdelta/EffectDelta 参照が無い（EffectDelta 配線は dev-flow.js のみ、という境界の固定）
// ============================================================

const EFFECTDELTA_REFERENCE_RE = /effectdelta|EffectDelta/;

const OTHER_WORKFLOW_FILES = [
  '.claude/workflows/pr-iterate.js',
  '.claude/workflows/dev-improve.js',
];

for (const relPath of OTHER_WORKFLOW_FILES) {
  test(`[effectdelta] (g) ${relPath} に effectdelta 参照が無い（EffectDelta 配線は dev-flow.js のみ）`, () => {
    const content = readFileSync(join(repoRoot, relPath), 'utf8');
    assert.equal(EFFECTDELTA_REFERENCE_RE.test(content), false, `${relPath} に effectdelta 参照が見つかった`);
  });
}

const AGENTS_DIR = join(repoRoot, '.claude/agents');
const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md'));

test('[effectdelta] (g) .claude/agents/ 配下に .md ファイルが存在する（テスト自体の健全性チェック）', () => {
  assert.ok(agentFiles.length > 0, '.claude/agents/*.md が見つからない');
});

for (const fileName of agentFiles) {
  test(`[effectdelta] (g) .claude/agents/${fileName} に effectdelta 参照が無い（新規 agent 型を追加せず既存 dev-runner-haiku/-ro を再利用）`, () => {
    const content = readFileSync(join(AGENTS_DIR, fileName), 'utf8');
    assert.equal(EFFECTDELTA_REFERENCE_RE.test(content), false, `.claude/agents/${fileName} に effectdelta 参照が見つかった`);
  });
}
