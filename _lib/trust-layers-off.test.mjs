// trust-layer 3 層（SurfaceProof / EvalSeal / EffectDelta）の出荷時 off invariant。
//
// *-routing.test.mjs 群は forceTrustShadow で source を shadow へ強制してから配線を検証する
// （off のまま放置して配線が腐ると復帰時に無検証のコードが動き出すため）。本ファイルはその対の
// invariant — **出荷 config では allowlist repo であっても trust call site が 1 つも実行されない**
// — を実測で pin する。片方だけでは「配線は生きているが出荷時に走っている」あるいは
// 「出荷時は走らないが配線が腐っている」を見逃す。
//
// off の理由・復帰条件は _lib/trust-wiring.mjs のコメントと
// .claude/rules/dev-flow.md の「trust-layer off 固定の sunset path」が正典。
//
// テストケース:
//   (a) canonical `_lib/trust-wiring.mjs` の TRUST_LAYER_CONFIG が 3 層とも 'off'
//   (b) 生成物 `.claude/workflows/dev-flow.js` の inline も 3 層とも 'off'（sync 漏れ検出）
//   (c) 出荷 source + repo=allowlist で run → trust 系 label の呼び出しが 1 件も無い
//   (d) 同 run の journal telemetry に trust_* キーが 1 つも現れない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';
import { readTrustLayerConfig } from './test-helpers/trust-layer-src.mjs';
import { TRUST_LAYER_CONFIG } from './trust-wiring.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
// 出荷そのままの source（forceTrustShadow を通さない — 本ファイルの検証対象が出荷 config のため）
const shippedSrc = readFileSync(devFlowPath, 'utf8');

const ALLOWLISTED_REPO = 'it-all-playpark/skills';
const TRUST_LAYERS = ['surfaceproof', 'evalseal', 'effectdelta'];

// trust 由来の agent label 接頭辞（dev-flow.js の trust call site が使う label 空間）
const TRUST_LABEL_PREFIXES = ['surfaceproof-shadow', 'trust-'];

const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 410,
  issue_title: 'stub-issue-title',
};

function responder({ label, agentType }) {
  if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
  if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-410', repo: ALLOWLISTED_REPO };
  if (label.startsWith('analyze')) return STANDARD_REQ;
  if (agentType === 'dev-planner') {
    return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
  }
  if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
  if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
  if (label === 'realized-diff') return { files: ['src/x.ts'] };
  if (agentType === 'evaluator') {
    return {
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
      ac_results: STANDARD_REQ.acceptance_criteria.map((_, i) => ({
        ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok',
      })),
      security_clearance: [], concern_resolutions: [],
    };
  }
  if (agentType === 'pr-reviewer') return { decision: 'approve', issues: [] };
  if (label.startsWith('ci-check')) return { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 0 };
  if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
  if (label === 'changed-files') return { files: ['src/x.ts'] };
  if (label === 'changed-files-final') return { files: [] };
  if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
  if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
  if (label === 'gh-pr-view') return { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
  if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
  if (label === 'journal-log') return { logged: true, summary: 'ok' };
  if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
  if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
  if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
  if (label === 'issue-meta') return { ok: true, number: 410, title: 'stub-issue-title' };
  return null;
}

async function runShipped() {
  const { ctx, calls } = makeRecordingSandbox(responder, {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 0 }),
    args: '410',
  });
  const stripped = shippedSrc
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  try {
    await vm.runInContext(`(async () => {\n${stripped}\n})();`, ctx, { filename: '.claude/workflows/dev-flow.js' });
  } catch (e) {
    if (e && (e.name === 'ReferenceError' || e.name === 'SyntaxError')) {
      assert.fail(`dev-flow.js が sandbox でクラッシュ: ${e.name}: ${e.message}`);
    }
  }
  return calls;
}

function extractTelemetryPayload(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n(\{[\s\S]*?\})\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ============================================================
// (a) canonical が全 layer 'off'
// ============================================================

test('[trust-off] (a) _lib/trust-wiring.mjs の TRUST_LAYER_CONFIG は 3 層とも off', () => {
  assert.deepEqual(Object.keys(TRUST_LAYER_CONFIG).sort(), [...TRUST_LAYERS].sort());
  for (const layer of TRUST_LAYERS) {
    assert.equal(
      TRUST_LAYER_CONFIG[layer], 'off',
      `(a) ${layer} は 'off' であること（復帰条件は _lib/trust-wiring.mjs のコメント参照。`
      + '満たさないまま shadow へ戻さない）',
    );
  }
});

// ============================================================
// (b) 生成物 dev-flow.js の inline も全 layer 'off'
// ============================================================

test('[trust-off] (b) dev-flow.js の inline TRUST_LAYER_CONFIG も 3 層とも off', () => {
  const modes = readTrustLayerConfig(shippedSrc);
  assert.deepEqual(
    modes, { surfaceproof: 'off', evalseal: 'off', effectdelta: 'off' },
    '(b) canonical を変えて tools/sync-inlines.mjs --write を忘れるとここで落ちる',
  );
});

// ============================================================
// (c) 出荷 source + allowlist repo → trust 系 agent 呼び出しゼロ
// ============================================================

test('[trust-off] (c) 出荷 config では allowlist repo でも trust 系 agent が 1 件も呼ばれない', async () => {
  const calls = await runShipped();

  const trustCalls = calls.filter((c) => TRUST_LABEL_PREFIXES.some((p) => c.label.startsWith(p)));
  assert.deepEqual(
    trustCalls.map((c) => c.label), [],
    '(c) trust 系 label の呼び出しが存在してはならない（off の call site は丸ごと skip される）',
  );

  // run 自体は完走している（trust ゼロが「run が早期に落ちただけ」でないことの positive control）
  assert.ok(
    calls.some((c) => c.label === 'journal-save'),
    '(c) journal-save まで到達していること — 到達前に落ちていると trust ゼロは無意味',
  );
});

// ============================================================
// (d) telemetry に trust_* キーが現れない
// ============================================================

test('[trust-off] (d) 出荷 config の run では journal telemetry に trust_* キーが無い', async () => {
  const calls = await runShipped();
  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, '(d) journal-save の呼び出しが存在すること');

  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, '(d) journal-save prompt から telemetry payload を JSON.parse できること');

  const trustKeys = Object.keys(payload.telemetry ?? {}).filter((k) => k.startsWith('trust_'));
  assert.deepEqual(
    trustKeys, [],
    '(d) telemetry に trust_* キーが現れてはならない（off では receipt も missing-reason も記録しない）',
  );
});
