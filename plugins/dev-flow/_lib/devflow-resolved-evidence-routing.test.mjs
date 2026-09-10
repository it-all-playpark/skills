// issue #603 F2: dev-flow.js 側の resolved_evidence 配線を検証するテスト。
// (a) buildJournalHandoffPayload の anchor 間 static 配線 pin
// (b) AC4 static pin — merge tier 判定〜resolvedEvidence〜summaryBody〜journal handoff の順序
//     が不変で、resolvedEvidence 以降に merge tier / ledger を書き換えるトークンが無いこと
// (c) VM: PR #595 相当（ledger 21 件 critical resolved + AC 4 件 satisfied）の payload サイズ回帰
// (d) VM: 解消済みが無い run では telemetry.resolved_evidence キー自体が省かれること
//
// makeSandbox / runDevFlowCapture は _lib/devflow-journal-log.test.mjs と同型のものを
// このファイルへ丸ごと複製し self-contained にする（post-summary prompt capture を追加）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const resolvedEvidencePath = join(here, 'resolved-evidence.mjs');
const summaryFormatPath = join(here, 'devflow-summary-format.mjs');

// ---- VM sandbox helpers（devflow-journal-log.test.mjs の makeSandbox / runDevFlowCapture と同型。
// post-summary prompt capture を追加）----

/**
 * @param {object} analyzeReq
 * @param {object} journalResult - journal-log stub が返すレスポンス
 * @param {object} [journalSaveResult]
 * @param {object} [evaluatorOverrides] - evaluator stub の最小 pass レスポンスへの override
 */
function makeSandbox(analyzeReq, journalResult, journalSaveResult, evaluatorOverrides) {
  let journalCallCount = 0;
  let journalSaveCallCount = 0;
  const journalPrompts = [];
  const journalLogPrompts = [];
  const postSummaryPrompts = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (agentType === 'dev-flow:dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'dev-flow:plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // 'danger-grep'（Security floor 統合 exec-proxy。SECFLOOR unified schema {risk,files,struct,diffhash}
    // を要求）と 'danger-grep-final'（Merge tier。単純 {ok,hits} schema）は別スキーマ。ここでは意図的に
    // 両方とも fail-closed に倒す（SEC seed 7 件を常に unchecked のまま保つ）ことで、
    // resolved_evidence.ledger_resolved を EVAL-* critical item のみに限定し payload サイズ回帰の
    // 検証をノイズなく行う（SEC/AC item の混入は要件外）。
    if (label === 'danger-grep-final') {
      return { ok: false, hits: [], error: 'stub-fail-closed' };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
        ...(evaluatorOverrides ?? {}),
      };
    }
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      postSummaryPrompts.push(prompt);
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      journalSaveCallCount += 1;
      journalPrompts.push(prompt);
      return journalSaveResult ?? { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      journalCallCount += 1;
      journalLogPrompts.push(prompt);
      if (journalResult instanceof Error) throw journalResult;
      return journalResult;
    }
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
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
    getJournalCallCount: () => journalCallCount,
    getJournalSaveCallCount: () => journalSaveCallCount,
    getJournalPrompts: () => journalPrompts,
    getJournalLogPrompts: () => journalLogPrompts,
    getPostSummaryPrompts: () => postSummaryPrompts,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * IIFE の resolved 値（return object）を捕捉して返す。
 */
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

// standard 経路に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// (a) 配線 static（anchor 間）
// ============================================================
test('[resolved-evidence-routing] (a) buildJournalHandoffPayload({ ... outcome: \'success\' ... }) 〜 subject: \'dev-flow 完走\' の anchor 間に resolved_evidence: resolvedEvidence が現れる', () => {
  let idx = 0;
  const occurrences = [];
  for (;;) {
    const i = src.indexOf("buildJournalHandoffPayload({", idx);
    if (i === -1) break;
    occurrences.push(i);
    idx = i + 1;
  }
  assert.ok(occurrences.length > 0, 'buildJournalHandoffPayload({ の出現が見つからない');

  const start = occurrences.find((i) => src.slice(i, i + 200).includes("outcome: 'success'"));
  assert.ok(start != null, "outcome: 'success' を直後 200 字に含む buildJournalHandoffPayload({ 出現が見つからない");

  const end = src.indexOf("subject: 'dev-flow 完走'", start);
  assert.ok(end > start, "subject: 'dev-flow 完走' が start より後に見つからない");

  const window = src.slice(start, end);
  assert.ok(
    window.includes('resolved_evidence: resolvedEvidence'),
    'success handoff の telemetry object に resolved_evidence: resolvedEvidence が無い',
  );
});

// ============================================================
// (b) AC4 static pin
// ============================================================
test('[resolved-evidence-routing] (b) AC4: merge tier 判定 → resolvedEvidence → summaryBody → journal handoff の順序が不変で、resolvedEvidence 以降に merge tier / ledger 書き換えトークンが無い', () => {
  const i1 = src.indexOf('const mergeTier = classifyMergeTier(');
  const i2 = src.indexOf('const resolvedEvidence = buildResolvedEvidence(');
  const i3 = src.indexOf('const summaryBody = buildDevflowSummaryBody(');
  // 'journal_log_status: journalLogStatus' は Analyze phase の needs_clarification 等の他 return
  // object にも現れるため、i3 以降（Merge tier の journal handoff return object）から探索する。
  const i4 = src.indexOf('journal_log_status: journalLogStatus', i3);

  assert.ok(i1 >= 0, 'const mergeTier = classifyMergeTier( が見つからない');
  assert.ok(i2 >= 0, 'const resolvedEvidence = buildResolvedEvidence( が見つからない');
  assert.ok(i3 >= 0, 'const summaryBody = buildDevflowSummaryBody( が見つからない');
  assert.ok(i4 >= 0, "i3 以降に journal_log_status: journalLogStatus が見つからない");
  assert.ok(i1 < i2 && i2 < i3 && i3 < i4, `順序が不変でない: i1=${i1} i2=${i2} i3=${i3} i4=${i4}`);

  const slice = src.slice(i2, i4);
  for (const tok of ['classifyMergeTier(', 'mergeTier =', 'mergeTier.tier =', 'state.ledger =']) {
    assert.ok(!slice.includes(tok), `resolvedEvidence 以降〜journal handoff 手前に禁止トークン '${tok}' が現れている`);
  }

  const resolvedEvidenceSrc = readFileSync(resolvedEvidencePath, 'utf8');
  const summaryFormatSrc = readFileSync(summaryFormatPath, 'utf8');
  for (const tok of ['classifyMergeTier', 'checkItem(', 'appendItem(', 'setCheck(']) {
    assert.ok(!resolvedEvidenceSrc.includes(tok), `_lib/resolved-evidence.mjs に禁止トークン '${tok}' が含まれている`);
    assert.ok(!summaryFormatSrc.includes(tok), `_lib/devflow-summary-format.mjs に禁止トークン '${tok}' が含まれている`);
  }
});

// ============================================================
// (c) VM: PR #595 相当の payload サイズ回帰
// ============================================================

// EVID(i): SENTINEL-EVIDENCE-<i> に | / ` / 改行 / 二重引用符 を含む合計 200 字の evidence。
function EVID(i) {
  const base = `SENTINEL-EVIDENCE-${i} | \`code\` \n"q"`;
  const pad = 'x'.repeat(Math.max(0, 200 - base.length));
  return base + pad;
}

const CRITICAL_FEEDBACK = Array.from({ length: 21 }, (_, i) => ({
  severity: 'critical',
  topic: `topic-${String(i).padStart(2, '0')}`,
  dimension: 'quality',
  description: 'd',
}));

const CRITICAL_RESOLUTIONS = Array.from({ length: 21 }, (_, i) => ({
  id: `EVAL-1-topic-${String(i).padStart(2, '0')}`,
  resolved: true,
  evidence: EVID(i),
}));

// ac_index はわざと ANALYZE_REQ.acceptance_criteria（4 件 → AC-1..AC-4 ledger item）の範囲外
// （100 オフセット）にする。ac_satisfied は evaluator の ac_results（このオブジェクト）から
// buildResolvedEvidence へ直接渡され ledger AC item を経由しないため出力には影響しないが、
// ac_index が AC-1..AC-4 と一致すると dev-flow.js の AC checkItem ループがそれらを checked にして
// しまい、advisory checked item として ledger_resolved に混入し 21 件ちょうどの検証が崩れる
// （F1 の buildResolvedEvidence advisory 選別は dimension:'ac' を除外しないため — ledger 上は
// 区別しない設計）。範囲外にして ledger 上の AC-* は unchecked のまま残す。
const AC_RESULTS_4 = Array.from({ length: 4 }, (_, i) => ({
  ac_index: 100 + i,
  satisfied: true,
  verified_by: 'inspection',
  evidence: EVID(100 + i),
}));

test('[resolved-evidence-routing] (c) VM: ledger 21 件 critical resolved + AC 4 件 satisfied（PR #595 相当）で journal-save payload が JSON.parse 可能・16000 字以下・raw evidence 保持', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalPrompts, getPostSummaryPrompts } = makeSandbox(ANALYZE_REQ, journalResult, undefined, {
    feedback: CRITICAL_FEEDBACK,
    critical_resolutions: CRITICAL_RESOLUTIONS,
    ac_results: AC_RESULTS_4,
  });

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result != null, 'run が abort してはならない');

  const savePrompt = getJournalPrompts()[0] ?? '';
  const beginIdx = savePrompt.indexOf('<<<JOURNAL_HANDOFF_BODY_BEGIN>>>');
  const endIdx = savePrompt.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>');
  assert.ok(beginIdx >= 0 && endIdx > beginIdx, 'journal-save prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない');
  const payloadStr = savePrompt.slice(beginIdx + '<<<JOURNAL_HANDOFF_BODY_BEGIN>>>'.length, endIdx).trim();

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    assert.fail(`journal-save payload が JSON.parse できない: ${e.message}\n${payloadStr}`);
  }

  const re = payload.telemetry.resolved_evidence;
  assert.ok(re != null, 'telemetry.resolved_evidence が無い');
  assert.equal(re.ledger_resolved.length, 21, `ledger_resolved.length は 21 のはずだが ${re.ledger_resolved.length}`);
  assert.equal(re.ac_satisfied.length, 4, `ac_satisfied.length は 4 のはずだが ${re.ac_satisfied.length}`);
  assert.ok(
    JSON.stringify(re).length <= 16000,
    `resolved_evidence の JSON.stringify 長は 16000 字以下のはずだが ${JSON.stringify(re).length}`,
  );
  const ev7 = re.ledger_resolved[7]?.evidence ?? '';
  assert.ok(ev7.includes('SENTINEL-EVIDENCE-7'), `ledger_resolved[7].evidence に 'SENTINEL-EVIDENCE-7' が含まれない: ${ev7}`);
  assert.ok(ev7.includes('|'), `ledger_resolved[7].evidence に '|' が含まれない: ${ev7}`);
  assert.ok(ev7.includes('`'), `ledger_resolved[7].evidence にバッククォートが含まれない: ${ev7}`);
  assert.ok(ev7.includes('\n'), `ledger_resolved[7].evidence に改行が含まれない: ${JSON.stringify(ev7)}`);
  assert.equal(payload.telemetry.merge_tier, result.merge_tier, 'telemetry.merge_tier が result.merge_tier と一致しない');

  const postSummaryPrompt = getPostSummaryPrompts()[0] ?? '';
  assert.ok(
    postSummaryPrompt.includes('✅ Goal Ledger 解消済み 21 件'),
    `post-summary prompt に '✅ Goal Ledger 解消済み 21 件' が含まれるべきだが含まれていなかった`,
  );
  assert.ok(
    postSummaryPrompt.includes(`<!-- dev-flow:${result.merge_tier} -->`),
    `post-summary prompt に '<!-- dev-flow:${result.merge_tier} -->' が含まれるべきだが含まれていなかった`,
  );
  assert.ok(
    !postSummaryPrompt.includes('SENTINEL-EVIDENCE-7'),
    `post-summary prompt に 'SENTINEL-EVIDENCE-7'（全文 evidence）が含まれるべきではないが含まれていた`,
  );
  assert.ok(
    !postSummaryPrompt.includes('<details>'),
    `post-summary prompt に '<details>' が含まれるべきではないが含まれていた`,
  );
});

// ============================================================
// (d) VM: 解消済みが無い run はキーを省く
// ============================================================
test('[resolved-evidence-routing] (d) VM: 解消済み無し（ac_results:[]）の run は telemetry.resolved_evidence キー自体が無い', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalPrompts } = makeSandbox(ANALYZE_REQ, journalResult, undefined, { ac_results: [] });

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result != null, 'run が abort してはならない');
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );

  const savePrompt = getJournalPrompts()[0] ?? '';
  const beginIdx = savePrompt.indexOf('<<<JOURNAL_HANDOFF_BODY_BEGIN>>>');
  const endIdx = savePrompt.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>');
  assert.ok(beginIdx >= 0 && endIdx > beginIdx, 'journal-save prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない');
  const payloadStr = savePrompt.slice(beginIdx + '<<<JOURNAL_HANDOFF_BODY_BEGIN>>>'.length, endIdx).trim();

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    assert.fail(`journal-save payload が JSON.parse できない: ${e.message}\n${payloadStr}`);
  }
  assert.equal(
    Object.hasOwn(payload.telemetry, 'resolved_evidence'),
    false,
    'telemetry.resolved_evidence キーは省かれるべきだが存在した',
  );
});
