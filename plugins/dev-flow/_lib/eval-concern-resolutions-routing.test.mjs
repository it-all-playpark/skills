// issue #296 (F4): concern-classify 導入後の dev-flow.js 配線回帰テスト。
//
// AC-1/2/3/4 を VM sandbox 実行で固定する:
//   - implementer が返す concerns のうち既知 4 パターンにマッチする文字列は ENV-* item に
//     分類され、eval#1 prompt の「未解消 concern 一覧」（CONCERN-* のみ対象）に現れない。
//   - 同一パターン key の concern は 1 件の ENV item に dedup され、発生件数が注記される。
//   - 非該当の concern は従来どおり CONCERN-* として要対応に残る。
//   - evaluator の concern_resolutions で resolution:'resolved' かつ evidence 付きの CONCERN-* は
//     checked になり要対応から消える。ENV-*/不明 id への指定は無視される。
//
// AC-5 は gate-policy.mjs の gateLane を直接呼び出す純関数ユニットとして固定する
// （environment/concern とも既定 policy 'llm-major-advisory' で advisory lane のまま、
// 収束判定が unchecked のまま true になる = W7 軸A 不変）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';
import { gateLane, isConvergedUnderPolicy, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem } from './goal-ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ============================================================
// responder: concern classify routing 専用の agent 応答
// implementer が Turbopack 系 concern ×3（同一パターン key） + 非該当 concern ×1 を返す。
// evaluator は concern_resolutions で CONCERN-1 / CONCERN-99（不明 id）/ ENV-TURBOPACK-SANDBOX
// （dimension 相違で無視される）を resolved:true として返す。
// ============================================================

function createResponder() {
  return function({ label, agentType }) {
    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-296' };
    }
    // Analyze: 必ず standard（micro だと Evaluate が skip され eval#1 が発生しない）
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a', 'b', 'c', 'd'],
        issue_type: 'fix',
        scope: 'src',
        estimated_change_file_count: 3,
        shape: 'standard',
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    // Plan: dev-planner（1 task を serial に置く）
    if (agentType === 'dev-flow:dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }],
        parallel: [],
      };
    }
    // Plan reviewer
    if (agentType === 'dev-flow:plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / danger-grep 系
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner
    if (label.startsWith('test')) {
      return { tests: 'passed', green: true, summary: '' };
    }
    // Evaluate: evaluator（concern_resolutions で CONCERN-1 を解消。CONCERN-99/ENV-* は無視される想定）
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
        concern_resolutions: [
          { id: 'CONCERN-1', resolution: 'resolved', evidence: 'src/x.ts:10 で検証追加' },
          { id: 'CONCERN-2', resolution: 'triaged', evidence: 'lib/y.ts:20 の shorthand 判定は未変更。advisory で実害なし、修正不要と判断' },
          { id: 'CONCERN-99', resolution: 'resolved', evidence: 'x' },
          { id: 'ENV-TURBOPACK-SANDBOX', resolution: 'resolved', evidence: 'x' },
        ],
      };
    }
    // realized-diff / declared-path-check / changed-files → files: [] で undeclared を発生させない
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
      return { files: [] };
    }
    // PR 系
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // diff-gate / diff-hash
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    // post-summary（dev-runner-haiku）
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // implementer（本経路の main call。concerns に既知 4 パターン系 ×3 + 非該当 ×1）
    if (agentType === 'dev-flow:implementer') {
      return {
        status: 'DONE_WITH_CONCERNS',
        task_id: 't1',
        files: ['src/x.ts'],
        summary: 's',
        concerns: [
          'sandbox 内で next build が TurbopackInternalError で失敗した',
          'next build 実行時に TurbopackInternalError が再発した（再現性あり）',
          'CI と異なり sandbox では next build が TurbopackInternalError を吐く',
          'CONCERN マーカー: ORDER BY 検証が未実装',
          'CONCERN マーカー: shorthand 判定の重複が残る',
        ],
      };
    }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    // デフォルト
    return null;
  };
}

// ============================================================
// 共有実行（複数テストが同じ sandbox 実行結果を参照する）
// ============================================================

let sharedCalls = null;
let sharedErr = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(createResponder());
  const err = await runDevFlowInSandbox(src, ctx);
  sharedCalls = calls;
  sharedErr = err;
}

test('[eval-concern-resolutions] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedErr && (sharedErr.name === 'ReferenceError' || sharedErr.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedErr.name}: ${sharedErr.message}`);
  }
});

test('[eval-concern-resolutions] AC-1/3: eval#1 prompt の未解消 concern 一覧に CONCERN-1 は含まれ ENV-TURBOPACK-SANDBOX は含まれない', async () => {
  await ensureSharedRun();
  const eval1 = sharedCalls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('未解消 concern 一覧'),
    `eval#1 の prompt に「未解消 concern 一覧」が含まれていない。\nprompt (先頭800文字):\n${eval1.prompt.slice(0, 800)}`,
  );
  assert.ok(
    eval1.prompt.includes('CONCERN-1'),
    `eval#1 の prompt に CONCERN-1 が含まれていない`,
  );
  assert.ok(
    !eval1.prompt.includes('ENV-TURBOPACK-SANDBOX'),
    `eval#1 の未解消 concern 一覧は CONCERN-* のみが対象のはずが ENV-TURBOPACK-SANDBOX を含んでいる`,
  );
});

// issue #603: post-summary は環境ノートの件数（グループ数）のみを常時可視で表示し、パターン別の
// dedup 件数・checked 状態・evidence 全文は journal telemetry `resolved_evidence.env_notes[]`
// （journal-save prompt の JOURNAL_HANDOFF_BODY payload）側に移された。post-summary 側の表形式
// アサートは資料的に古くなったため、件数行の存在確認 + journal 側での dedup 件数検証に置き換える。
function extractResolvedEvidence(calls) {
  const journalSave = calls.find((c) => c.label === 'journal-save');
  assert.ok(
    journalSave != null,
    `label === 'journal-save' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  const beginIdx = journalSave.prompt.indexOf('<<<JOURNAL_HANDOFF_BODY_BEGIN>>>');
  const endIdx = journalSave.prompt.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>');
  assert.ok(beginIdx >= 0 && endIdx > beginIdx, 'journal-save prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない');
  const payloadStr = journalSave.prompt.slice(beginIdx + '<<<JOURNAL_HANDOFF_BODY_BEGIN>>>'.length, endIdx).trim();
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    assert.fail(`journal-save payload が JSON.parse できない: ${e.message}\n${payloadStr}`);
  }
  return payload.telemetry?.resolved_evidence ?? null;
}

test('[eval-concern-resolutions] AC-2: post-summary prompt に環境ノート件数行が現れ、要対応テーブルに ENV/Turbopack 行が無く、dedup 件数 3 は journal telemetry resolved_evidence.env_notes 側で確認できる', async () => {
  await ensureSharedRun();
  const post = sharedCalls.find((c) => c.label === 'post-summary');
  assert.ok(
    post != null,
    `label === 'post-summary' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    post.prompt.includes('環境ノート'),
    `post-summary の prompt に「環境ノート」が含まれていない`,
  );
  assert.ok(
    post.prompt.includes('🏗 環境ノート 1 件'),
    `post-summary の prompt に環境ノートのグループ件数行（1 件 = turbopack-sandbox パターン 1 グループ）が見つからない。\nprompt 抜粋:\n${post.prompt.slice(post.prompt.indexOf('環境ノート') - 50, post.prompt.indexOf('環境ノート') + 500)}`,
  );
  const actionSection = post.prompt.slice(
    post.prompt.indexOf('### ⚠️ 要対応'),
    post.prompt.indexOf('環境ノート') > -1 ? post.prompt.indexOf('環境ノート') : undefined,
  );
  assert.ok(
    !/ENV-|turbopack/i.test(actionSection),
    `要対応セクションに ENV- / turbopack 行が残っている（環境ノートへ隔離されるべき）:\n${actionSection}`,
  );

  // dedup 件数 3（TURBOPACK_CONCERNS 相当 3 件の implementer concerns が同一 env_key に集約された件数）は
  // post-summary から journal telemetry resolved_evidence.env_notes[].env_count へ移った（issue #603）。
  const re = extractResolvedEvidence(sharedCalls);
  assert.ok(re != null, 'telemetry.resolved_evidence が無い');
  const note = re.env_notes.find((n) => n.env_key === 'turbopack-sandbox');
  assert.ok(
    note != null,
    `resolved_evidence.env_notes に turbopack-sandbox が無い: ${JSON.stringify(re.env_notes)}`,
  );
  assert.equal(
    note.env_count,
    3,
    `resolved_evidence.env_notes[turbopack-sandbox].env_count は 3 のはずが ${note.env_count}`,
  );
});

test('[eval-concern-resolutions] AC-4: CONCERN-1 は evaluator の concern_resolutions で resolve され要対応から消える', async () => {
  await ensureSharedRun();
  const post = sharedCalls.find((c) => c.label === 'post-summary');
  assert.ok(post != null);
  const actionSection = post.prompt.slice(
    post.prompt.indexOf('### ⚠️ 要対応'),
    post.prompt.indexOf('環境ノート') > -1 ? post.prompt.indexOf('環境ノート') : undefined,
  );
  assert.ok(
    !/\bCONCERN-1\b/.test(actionSection),
    `CONCERN-1 は resolved:true + evidence 付きで返されているため要対応から消えているべき:\n${actionSection}`,
  );
});

// ============================================================
// AC-5: environment/concern とも既定 policy で advisory lane のまま、収束判定が不変であること
// （gate-policy.mjs の gateLane / isConvergedUnderPolicy を直接検証。W7 軸A 不変）
// ============================================================

test('[eval-concern-resolutions][AC-5] ENV item (severity minor) と CONCERN item (severity major) は既定 policy で共に advisory', () => {
  const envItem = {
    id: 'ENV-TURBOPACK-SANDBOX', text: 't', dimension: 'environment', severity: 'minor',
    source: 'concern', check: { kind: 'inspection' }, checked: false,
  };
  const concernItem = {
    id: 'CONCERN-1', text: 'c', dimension: 'concern', severity: 'major',
    source: 'concern', check: { kind: 'inspection' }, checked: false,
  };
  assert.equal(gateLane(envItem, DEFAULT_GATE_POLICY), 'advisory');
  assert.equal(gateLane(concernItem, DEFAULT_GATE_POLICY), 'advisory');
});

test('[eval-concern-resolutions][AC-5] 両 item が unchecked のまま isConvergedUnderPolicy は true（advisory は収束を block しない）', () => {
  let ledger = makeLedger();
  ledger = appendItem(ledger, {
    id: 'ENV-TURBOPACK-SANDBOX', text: 't', dimension: 'environment', severity: 'minor',
    source: 'concern', check: { kind: 'inspection' },
  }).ledger;
  ledger = appendItem(ledger, {
    id: 'CONCERN-1', text: 'c', dimension: 'concern', severity: 'major',
    source: 'concern', check: { kind: 'inspection' },
  }).ledger;
  assert.equal(isConvergedUnderPolicy(ledger, DEFAULT_GATE_POLICY), true);
});

// ============================================================
// issue #614: triaged resolution の routing 回帰
// ============================================================

test('[eval-concern-resolutions][#614] CONCERN-2 は triaged として post-summary の要対応表に「🔹 トリアージ済み」+ evidence で現れ、見出し「### ⚠️ 要対応」が出る', async () => {
  await ensureSharedRun();
  const post = sharedCalls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  const actionSection = post.prompt.slice(
    post.prompt.indexOf('### ⚠️ 要対応'),
    post.prompt.indexOf('環境ノート') > -1 ? post.prompt.indexOf('環境ノート') : undefined,
  );
  assert.ok(
    post.prompt.includes('### ⚠️ 要対応'),
    `post-summary の prompt に「### ⚠️ 要対応」見出しが無い`,
  );
  assert.ok(
    actionSection.includes('🔹 トリアージ済み'),
    `要対応セクションに「🔹 トリアージ済み」が無い:\n${actionSection}`,
  );
  assert.ok(
    actionSection.includes('shorthand 判定は未変更'),
    `要対応セクションに CONCERN-2 の triaged evidence が無い:\n${actionSection}`,
  );
  assert.ok(
    !/CONCERN-2[^\n]*❌ 未解消/.test(actionSection),
    `CONCERN-2 が ❌ 未解消 として出ている（triaged 反映漏れ）:\n${actionSection}`,
  );
});

test('[eval-concern-resolutions][#614] triaged は ledger 収束を変えない（post-summary の at-a-glance に「✅ 収束」が出る）', async () => {
  await ensureSharedRun();
  const post = sharedCalls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  assert.ok(
    post.prompt.includes('✅ 収束'),
    `post-summary の prompt に「✅ 収束」が無い（triaged が checked 扱いされ収束判定を変えている可能性）:\nprompt(先頭1500):\n${post.prompt.slice(0, 1500)}`,
  );
});
