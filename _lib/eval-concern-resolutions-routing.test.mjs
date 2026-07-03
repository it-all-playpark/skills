// issue #296 (F4): concern-classify 導入後の dev-flow.js 配線回帰テスト。
//
// AC-1/2/3/4 を VM sandbox 実行で固定する:
//   - implementer が返す concerns のうち既知 4 パターンにマッチする文字列は ENV-* item に
//     分類され、eval#1 prompt の「未解消 concern 一覧」（CONCERN-* のみ対象）に現れない。
//   - 同一パターン key の concern は 1 件の ENV item に dedup され、発生件数が注記される。
//   - 非該当の concern は従来どおり CONCERN-* として要対応に残る。
//   - evaluator の concern_resolutions で resolved:true かつ evidence 付きの CONCERN-* は
//     checked になり要対応から消える。ENV-*/不明 id への指定は無視される。
//
// AC-5 は gate-policy.mjs の gateLane を直接呼び出す純関数ユニットとして固定する
// （environment/concern とも既定 policy 'llm-major-advisory' で advisory lane のまま、
// 収束判定が unchecked のまま true になる = W7 軸A 不変）。

import { test } from 'node:test';
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
      };
    }
    // Plan: dev-planner（1 task を serial に置く）
    if (agentType === 'dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }],
        parallel: [],
      };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
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
    if (agentType === 'evaluator') {
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
          { id: 'CONCERN-1', resolved: true, evidence: 'src/x.ts:10 で検証追加' },
          { id: 'CONCERN-99', resolved: true, evidence: 'x' },
          { id: 'ENV-TURBOPACK-SANDBOX', resolved: true, evidence: 'x' },
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
    // post-summary（dev-runner）
    if (label === 'post-summary' && agentType === 'dev-runner') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // implementer（本経路の main call。concerns に既知 4 パターン系 ×3 + 非該当 ×1）
    if (agentType === 'implementer') {
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
        ],
      };
    }
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

test('[eval-concern-resolutions] AC-2: post-summary prompt に環境ノートと件数 3 が現れ、要対応テーブルに ENV/Turbopack 行が無い', async () => {
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
    /ENV-TURBOPACK-SANDBOX\s*\|\s*turbopack-sandbox\s*\|\s*3\s*\|/.test(post.prompt),
    `post-summary の prompt の環境ノートテーブルに件数 3 の dedup 行が見つからない。\nprompt 抜粋:\n${post.prompt.slice(post.prompt.indexOf('環境ノート') - 50, post.prompt.indexOf('環境ノート') + 500)}`,
  );
  const actionSection = post.prompt.slice(
    post.prompt.indexOf('### ⚠️ 要対応'),
    post.prompt.indexOf('環境ノート') > -1 ? post.prompt.indexOf('環境ノート') : undefined,
  );
  assert.ok(
    !/ENV-|turbopack/i.test(actionSection),
    `要対応セクションに ENV- / turbopack 行が残っている（環境ノートへ隔離されるべき）:\n${actionSection}`,
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
