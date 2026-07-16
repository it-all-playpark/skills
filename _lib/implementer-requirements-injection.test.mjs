// implementer prompt への AC・plan contract 注入を source + routing の 2 層で pin する（issue #224）。
//
// 背景（issue #224）:
//   evaluator は acceptance_criteria ベースで実装を採点する（各 AC を satisfied/unsatisfied で判定）。
//   しかし従来の implPrompt は task と STAGING_CONVENTION のみを渡していたため、implementer は
//   AC を知らずに実装を行う情報非対称が存在した。この非対称を解消するため、implPrompt に
//   req.acceptance_criteria / plan.summary / plan.architecture_decisions / plan.edge_cases を注入する。
//
// AC4 確認結果:
//   telemetry の eval_iter は dev-flow.js の telemetry handoff オブジェクト（`eval_iter: evalIters`）に
//   既存（line 2013 付近）。注入前後で比較するような追加実装は不要 — 既存テストの範囲外。
//
// このテストは:
//   層 1 (source pin):
//     implPrompt 区間（function implPrompt から async function runImplement まで）に以下が含まれる:
//       (1) 'acceptance_criteria' が含まれる
//       (2) 'plan?.summary' または 'plan.summary' が含まれる
//       (3) 'architecture_decisions' が含まれる
//       (4) 'edge_cases' が含まれる
//       (5) 'requirements' ラベルが含まれる（implementer.md 宣言済み入力名との一致 = AC2 検証）
//   層 2 (routing pin — VM sandbox):
//       (6) implementer 呼び出しが 2 件以上（serial T1 + parallel T2）
//       (7) label に ':serial:' を含む implementer call が >= 1
//       (8) label に ':par:' を含む implementer call が >= 1
//       (9) 全 implementer call の prompt に 5 sentinel トークンが含まれる:
//           'AC_SENTINEL_ONE' / 'AC_SENTINEL_TWO' / 'PLAN_SUMMARY_SENTINEL' /
//           'ARCH_DECISION_SENTINEL' / 'EDGE_CASE_SENTINEL'
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// 層 1: source pin
// implPrompt 区間を切り出して必要トークンを assert する
// ============================================================

// implPrompt 区間 = function implPrompt の開始から async function runImplement の開始まで
const implPromptStart = src.indexOf('function implPrompt');
const implPromptEnd = src.indexOf('async function runImplement');

if (implPromptStart === -1) {
  throw new Error('dev-flow.js に function implPrompt が見つからない');
}
if (implPromptEnd === -1) {
  throw new Error('dev-flow.js に async function runImplement が見つからない');
}

const implPromptSection = src.slice(implPromptStart, implPromptEnd);

if (!(implPromptEnd > implPromptStart)) {
  throw new Error(
    'implPrompt 区間の終端 anchor (async function runImplement) が開始 anchor (function implPrompt) より後に来ること。'
    + '逆転すると区間が空になり以降の包含 assert が無意味化する（窓ズレ検出）',
  );
}
if (!(implPromptSection.length > 100)) {
  throw new Error(
    'implPrompt 区間が十分な長さを持つこと（窓ズレ検出: 異常に短ければ anchor 取得が壊れている）。'
    + `現在の長さ: ${implPromptSection.length}`,
  );
}

test('[requirements-injection] implPrompt 区間に acceptance_criteria が含まれる', () => {
  assert.ok(
    implPromptSection.includes('acceptance_criteria'),
    'implPrompt 区間に "acceptance_criteria" が存在しない。AC を implementer prompt に注入すること（issue #224）',
  );
});

test('[requirements-injection] implPrompt 区間に plan.summary への参照が含まれる', () => {
  const hasPlanSummary =
    implPromptSection.includes('plan?.summary') || implPromptSection.includes('plan.summary');
  assert.ok(
    hasPlanSummary,
    'implPrompt 区間に "plan?.summary" / "plan.summary" が存在しない。plan contract を implementer prompt に注入すること（issue #224）',
  );
});

test('[requirements-injection] implPrompt 区間に architecture_decisions が含まれる', () => {
  assert.ok(
    implPromptSection.includes('architecture_decisions'),
    'implPrompt 区間に "architecture_decisions" が存在しない。plan contract を implementer prompt に注入すること（issue #224）',
  );
});

test('[requirements-injection] implPrompt 区間に edge_cases が含まれる', () => {
  assert.ok(
    implPromptSection.includes('edge_cases'),
    'implPrompt 区間に "edge_cases" が存在しない。plan contract を implementer prompt に注入すること（issue #224）',
  );
});

test('[requirements-injection] implPrompt 区間に requirements ラベルが含まれる（implementer.md AC2 = 入力名一致）', () => {
  assert.ok(
    implPromptSection.includes('requirements'),
    'implPrompt 区間に "requirements" ラベルが存在しない。'
    + 'implementer.md は requirements を宣言済み入力名として列挙しており、prompt のラベルと一致させること（AC2）',
  );
});

// ============================================================
// 層 2: routing pin（VM sandbox）
// implementer-staging-convention.test.mjs の makeCountingSandbox / runDevFlowInSandbox を
// 同型構造で self-contained にコピーして流用する（共有 helper 抽出はしない — 既存ルーティングテスト群も
// 各自コピー保持の慣例）。
// stub に sentinel token を注入し、全 implementer call の prompt に到達することを確認する。
// ============================================================

/**
 * requirements-injection routing 専用の VM sandbox を組む。
 * analyze stub に AC sentinel、dev-planner stub に plan sentinel を注入して
 * implPrompt 経由で implementer に届くことを検証する。
 *
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox() {
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt) });

    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['AC_SENTINEL_ONE', 'AC_SENTINEL_TWO'],
        issue_type: 'feat',
        scope: 'src',
        estimated_change_file_count: 3,
        shape: 'standard',
      };
    }
    if (agentType === 'dev-planner') {
      return {
        summary: 'PLAN_SUMMARY_SENTINEL',
        architecture_decisions: [{ decision: 'ARCH_DECISION_SENTINEL', rationale: 'r' }],
        edge_cases: [{ case: 'EDGE_CASE_SENTINEL', handling: 'h' }],
        serial: [{ id: 'T1', desc: 'impl', file_changes: ['src/a.ts'], test_plan: 'none', depends_on: [] }],
        parallel: [{ id: 'T2', desc: 'impl2', file_changes: ['src/b.ts'], test_plan: 'none', depends_on: [] }],
      };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label === 'realized-diff') {
      return { files: ['src/a.ts', 'src/b.ts'] };
    }
    if (label === 'declared-path-check') {
      return { files: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/a.ts', 'src/b.ts'] };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'done', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
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
  return { ctx, calls };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * implementer-staging-convention.test.mjs の runDevFlowInSandbox と同型。
 */
async function runDevFlowInSandbox(source, ctx) {
  const stripped = source
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = '(async () => {\n' + stripped + '\n})();';

  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

// ============================================================
// routing pin テスト
// ============================================================

test('[requirements-injection] routing: implementer 呼び出しが 2 件以上（serial T1 + parallel T2）', async () => {
  const { ctx, calls } = makeCountingSandbox();
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const implCalls = calls.filter((c) => c.agentType === 'implementer');

  assert.ok(
    implCalls.length >= 2,
    `implementer 呼び出しが 2 件未満（${implCalls.length} 件）。serial T1 + parallel T2 の両方が実行されるはず。`
    + ` labels: ${implCalls.map((c) => c.label).join(', ')}`,
  );
});

test('[requirements-injection] routing: :serial: と :par: の両 label の implementer call が存在する', async () => {
  const { ctx, calls } = makeCountingSandbox();
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const implCalls = calls.filter((c) => c.agentType === 'implementer');
  const serialCalls = implCalls.filter((c) => c.label.includes(':serial:'));
  const parCalls = implCalls.filter((c) => c.label.includes(':par:'));

  assert.ok(
    serialCalls.length >= 1,
    `':serial:' を含む implementer call が 0 件。serial[T1] が実行されるはず。`
    + ` 全 labels: ${implCalls.map((c) => c.label).join(', ')}`,
  );

  assert.ok(
    parCalls.length >= 1,
    `':par:' を含む implementer call が 0 件。parallel[T2] が fan-out されるはず。`
    + ` 全 labels: ${implCalls.map((c) => c.label).join(', ')}`,
  );
});

test('[requirements-injection] routing: 全 implementer call の prompt に 5 つの sentinel が含まれる', async () => {
  const { ctx, calls } = makeCountingSandbox();
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const implCalls = calls.filter((c) => c.agentType === 'implementer');

  assert.ok(
    implCalls.length >= 1,
    `implementer が呼ばれていない（0 件）`,
  );

  const sentinels = [
    'AC_SENTINEL_ONE',
    'AC_SENTINEL_TWO',
    'PLAN_SUMMARY_SENTINEL',
    'ARCH_DECISION_SENTINEL',
    'EDGE_CASE_SENTINEL',
  ];

  for (const c of implCalls) {
    for (const sentinel of sentinels) {
      assert.ok(
        c.prompt.includes(sentinel),
        `implementer prompt (label=${c.label}) に sentinel '${sentinel}' が含まれない。`
        + `AC・plan contract（summary / architecture_decisions / edge_cases）が注入されていない（issue #224）`,
      );
    }
  }
});
