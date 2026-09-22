// issue #603 F2: dev-flow.js 側の resolved_evidence 配線を検証するテスト。
// (b) VM: calls 上で post-summary の呼び出しが journal-save より前（配線順序の挙動証拠）+
//     journal-save prompt JSON の merge_tier が result.merge_tier と一致 + resolved_evidence の
//     text/evidence フィールドが 1000 字で cap されること
// (c) VM: PR #595 相当（ledger 21 件 critical resolved + AC 4 件 satisfied）の payload サイズ回帰
// (d) VM: 解消済みが無い run では telemetry.resolved_evidence キー自体が省かれること
// (e) VM: 実 run 形状（ac_index が acceptance_criteria の範囲内）の payload 回帰
//
// makeSandbox / runDevFlowCapture は _lib/devflow-journal-log.test.mjs と同型のものを
// このファイルへ丸ごと複製し self-contained にする（post-summary prompt capture + calls 順序
// tracking を追加）。ソース anchor 間の静的走査（旧 (a)(b)）は挙動検証（VM の calls 順序 /
// 返り値・payload 一致 / cap 検証）へ置換した（issue #636 AC-1/AC-4）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

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
  // calls: 呼び出し順序を pin するための label 記録配列（issue #636 AC-1 の VM 挙動検証用）
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType });

    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
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
    if (agentType === 'dev-flow:dev-implement-fable') {
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
    args: devFlowArgs('1'),
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
    getCalls: () => calls,
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
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// (b) VM: 呼び出し順序 + merge_tier 一致 + resolved_evidence の 1000 字 cap
// ============================================================

// 1000 字 cap の実証用: 1 件のみの critical resolution に 1500 字の evidence を与え、
// buildAtCap の初期 cap（1000）でちょうど truncate されることを検証する（他配列を空に保ち
// 16000 字上限による cap 半減が発火しない規模に収める）。
const LONG_EVIDENCE = 'E'.repeat(1500);

test('[resolved-evidence-routing] (b) VM: calls 順序（post-summary < journal-save）+ journal-save payload の merge_tier 一致 + resolved_evidence の 1000 字 cap', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalPrompts, getCalls } = makeSandbox(ANALYZE_REQ, journalResult, undefined, {
    feedback: [{ severity: 'critical', topic: 'topic-00', dimension: 'quality', description: 'd' }],
    critical_resolutions: [{ id: 'EVAL-1-topic-00', resolved: true, evidence: LONG_EVIDENCE }],
    ac_results: [],
  });

  const { result, error } = await runDevFlowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result != null, 'run が abort してはならない');

  // 呼び出し順序: post-summary（終端サマリー投稿）は journal-save（telemetry payload 保存）より前
  const calls = getCalls();
  const postSummaryIdx = calls.findIndex((c) => c.label === 'post-summary');
  const journalSaveIdx = calls.findIndex((c) => c.label === 'journal-save');
  assert.ok(postSummaryIdx >= 0, "calls に 'post-summary' が存在しない");
  assert.ok(journalSaveIdx >= 0, "calls に 'journal-save' が存在しない");
  assert.ok(
    postSummaryIdx < journalSaveIdx,
    `(b) post-summary(idx=${postSummaryIdx}) は journal-save(idx=${journalSaveIdx}) より前に呼ばれるべき`,
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

  assert.equal(payload.telemetry.merge_tier, result.merge_tier, 'telemetry.merge_tier が result.merge_tier と一致しない');

  const re = payload.telemetry.resolved_evidence;
  assert.ok(re != null, 'telemetry.resolved_evidence が無い');
  const item = re.ledger_resolved.find((it) => it.id === 'EVAL-1-topic-00');
  assert.ok(item != null, "ledger_resolved に 'EVAL-1-topic-00' が無い");
  assert.equal(item.evidence.length, 1000, `(b) evidence は 1000 字で cap されるべきだが ${item.evidence.length} 字だった`);
  assert.equal(re.truncated, true, '(b) 1500 字の evidence を 1000 字 cap した場合 truncated===true のはず');
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

  // 件数（21 件）そのものは上の re.ledger_resolved.length===21 assertion が担う（journal telemetry
  // 側の routing）。post-summary prompt 側は marker と否定側 pin のみを検証する（issue #636 AC-1）。
  const postSummaryPrompt = getPostSummaryPrompts()[0] ?? '';
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

// ============================================================
// (e) VM: 実 run 形状（ac_index が acceptance_criteria の範囲内）の payload 回帰
// ============================================================

// (c) は ac_index を範囲外（100 オフセット）にして ledger 上の AC-1..4 を unchecked に留め、
// ledger_resolved を EVAL-* 21 件だけに絞っている。しかし実 run の evaluator は
// acceptance_criteria の範囲内の ac_index を返すため、dev-flow.js の AC ループ
// (`else if (r.satisfied) ledger = checkItem(ledger, acId, ...)`) が AC-1..4 を checked にし、
// gate policy llm-major-advisory 下で severity:'major' の AC item は advisory lane に入る。
// buildResolvedEvidence の advisory 述語は dimension:'ac' を除外しないため、実 run の
// ledger_resolved は 21 + 4 = 25 件になり、同じ AC evidence が ac_satisfied にも載る（二重計上）。
// (c) だけでは payload サイズ回帰ガードが実 run より小さい形状でしか検証されないため、
// 実 run 形状での件数と 16000 字上限を pin する。advisory 述語から dimension:'ac' を
// 除外する等でこの二重計上を変える場合、本 test が先に red になる。
const AC_RESULTS_INRANGE = Array.from({ length: 4 }, (_, i) => ({
  ac_index: i,
  satisfied: true,
  verified_by: 'inspection',
  evidence: EVID(300 + i),
}));

test('[resolved-evidence-routing] (e) VM: ac_index 範囲内の実 run 形状では ledger_resolved が 21+AC 4 件 = 25 件になり、payload は JSON.parse 可能・16000 字以下・merge_tier 一致', async () => {
  const journalResult = { logged: true, summary: 'ok' };
  const { ctx, getJournalPrompts, getPostSummaryPrompts } = makeSandbox(ANALYZE_REQ, journalResult, undefined, {
    feedback: CRITICAL_FEEDBACK,
    critical_resolutions: CRITICAL_RESOLUTIONS,
    ac_results: AC_RESULTS_INRANGE,
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
  assert.equal(
    re.ledger_resolved.length,
    25,
    `実 run 形状の ledger_resolved.length は 21(EVAL-*) + 4(AC-*) = 25 のはずだが ${re.ledger_resolved.length}`,
  );
  for (let i = 1; i <= 4; i += 1) {
    const acEntry = re.ledger_resolved.find((it) => it.id === `AC-${i}`);
    assert.ok(acEntry != null, `ledger_resolved に AC-${i} が無い: ${re.ledger_resolved.map((it) => it.id).join(',')}`);
    assert.equal(acEntry.lane, 'advisory', `AC-${i} は advisory lane のはずだが ${acEntry.lane}`);
    assert.equal(acEntry.dimension, 'ac', `AC-${i} の dimension は 'ac' のはずだが ${acEntry.dimension}`);
  }
  assert.equal(re.ac_satisfied.length, 4, `ac_satisfied.length は 4 のはずだが ${re.ac_satisfied.length}`);
  assert.ok(
    JSON.stringify(re).length <= 16000,
    `実 run 形状でも resolved_evidence の JSON.stringify 長は 16000 字以下のはずだが ${JSON.stringify(re).length}`,
  );
  assert.equal(payload.telemetry.merge_tier, result.merge_tier, 'telemetry.merge_tier が result.merge_tier と一致しない');

  // 件数（25 件）そのものは上の re.ledger_resolved.length===25 assertion が担う（issue #636 AC-1）。
});
