// runImplement の実行順（parallel → serial）と serial の fail-open 化を source + VM の 2 層で pin する
// （issue #534）。
//
// 背景（issue #534）:
//   従来の runImplement は plan.serial を先に順次実行し、plan.parallel を後に fan-out していた。
//   dev-planner の定義（serial=依存あり / parallel=独立）と整合させるには、独立している parallel を
//   先に実行し、serial がその成果物に依存できるようにする必要がある（AC-1）。
//   また serial 側は trackedAgent を直接呼んでおり、implementer が throw すると run 全体が abort
//   していた。parallel 側と同様に failOpenAgent（throw→null 吸収）へ合流させる（AC-2）。
//
// このテストは:
//   層 1 (source pin):
//     runImplement 窓（`async function runImplement` から次の `// ====...` 区切りまで）に対して:
//       (a) 窓内で 'await parallel(' の index が 'for (const t of (plan.serial' の index より小さい
//           （parallel 先行の実行順）
//       (b) 窓内に 'failOpenAgent(' が含まれる（serial fail-open 化）
//       (c) 窓長 > 100（窓ズレ検出）
//   層 2 (VM 動作検証):
//     窓ソースを vm.runInContext で評価し、stub agent/parallel/log を注入して:
//       (d) plan.serial + plan.parallel を含む plan で、parallel 呼び出しが serial 呼び出しより先に
//           観測される（実行順の直接観測）
//       (e) serial task が throw しても runImplement は reject せず resolve し、
//           返り値から throw した serial task の結果が欠落し、parallel task の結果は含まれ、
//           fail-open の警告 log が記録される
//       (f) plan.serial / plan.parallel が undefined でも例外なく空配列を返す
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
// runImplement 窓を切り出して実行順・fail-open 化を assert する
// ============================================================

const runImplementStart = src.indexOf('async function runImplement');
if (runImplementStart === -1) {
  throw new Error('dev-flow.js に async function runImplement が見つからない');
}

const nextSeparatorIdx = src.indexOf('// ============', runImplementStart);
if (nextSeparatorIdx === -1) {
  throw new Error('runImplement 窓の終端 anchor（次の // ============ 区切り）が見つからない');
}

const runImplementWindow = src.slice(runImplementStart, nextSeparatorIdx);

if (!(nextSeparatorIdx > runImplementStart)) {
  throw new Error(
    'runImplement 窓の終端 anchor が開始 anchor より後に来ること。'
    + '逆転すると区間が空になり以降の包含 assert が無意味化する（窓ズレ検出）',
  );
}

test('[implement-order-failopen] source: 窓長が十分（窓ズレ検出）', () => {
  assert.ok(
    runImplementWindow.length > 100,
    `runImplement 窓が異常に短い（窓ズレ検出）。現在の長さ: ${runImplementWindow.length}`,
  );
});

test('[implement-order-failopen] source: parallel fan-out が serial ループより先に実行される', () => {
  const parIdx = runImplementWindow.indexOf('await parallel(');
  const serialIdx = runImplementWindow.indexOf('for (const t of (plan.serial');

  assert.notStrictEqual(parIdx, -1, "runImplement 窓に 'await parallel(' が見つからない");
  assert.notStrictEqual(serialIdx, -1, "runImplement 窓に 'for (const t of (plan.serial' が見つからない");
  assert.ok(
    parIdx < serialIdx,
    `parallel fan-out（index=${parIdx}）が serial ループ（index=${serialIdx}）より先に実行されるべき`
    + '（issue #534 AC-1: parallel は独立しているため先行実行、serial はその成果に依存し得る）',
  );
});

test('[implement-order-failopen] source: serial 実行が failOpenAgent 経由（fail-open 化）', () => {
  assert.ok(
    runImplementWindow.includes('failOpenAgent('),
    "runImplement 窓に 'failOpenAgent(' が含まれない。serial implementer 呼び出しは"
    + ' trackedAgent 直呼びではなく failOpenAgent 経由にし throw→null を吸収すること（issue #534 AC-2）',
  );
});

// ============================================================
// 層 2: VM 動作検証
// ============================================================

/**
 * runImplement 窓ソースを vm sandbox で評価する。stub agent/parallel/log を注入する。
 *
 * @param {{ throwOnLabel?: string }} opts throwOnLabel を指定すると当該 label の trackedAgent 呼び出しで throw する
 * @returns {{ ctx: vm.Context, calls: Array<{label: string}>, logs: string[] }}
 */
function makeSandbox({ throwOnLabel } = {}) {
  const calls = [];
  const logs = [];

  async function trackedAgentStub(prompt, opts) {
    const label = opts?.label ?? '';
    calls.push({ label });
    if (throwOnLabel && label === throwOnLabel) {
      throw new Error(`stub throw for ${label}`);
    }
    return { status: 'DONE', task_id: label, ok: true };
  }

  // 本物の failOpenAgent（dev-flow.js:4057）と同型: trackedAgent を try/catch し throw→null
  async function failOpenAgentStub(prompt, opts) {
    try {
      return await trackedAgentStub(prompt, opts);
    } catch (e) {
      logs.push(`⚠️ ${opts?.label ?? 'exec-proxy'} fail-open: ${e?.message ?? e}`);
      return null;
    }
  }

  const parallelStub = (fns) => Promise.all((fns || []).map((f) => f()));
  const implPromptStub = (t) => `p:${t.id}`;
  const logStub = (msg) => logs.push(msg);

  const ctx = vm.createContext({
    trackedAgent: trackedAgentStub,
    failOpenAgent: failOpenAgentStub,
    parallel: parallelStub,
    implPrompt: implPromptStub,
    log: logStub,
    IMPL: {},
    Promise,
    Array,
    Object,
    JSON,
    console,
  });

  return { ctx, calls, logs };
}

function loadRunImplement(ctx) {
  vm.runInContext(runImplementWindow, ctx, { filename: '.claude/workflows/dev-flow.js' });
  const fn = ctx.runImplement;
  if (typeof fn !== 'function') {
    throw new Error('runImplement 窓を評価しても runImplement 関数が得られなかった（窓ズレの可能性）');
  }
  return fn;
}

test('[implement-order-failopen] VM: parallel 呼び出しが serial 呼び出しより先に観測される', async () => {
  const { ctx, calls } = makeSandbox();
  const runImplement = loadRunImplement(ctx);

  const plan = {
    serial: [{ id: 'S1' }],
    parallel: [{ id: 'P1' }, { id: 'P2' }],
  };

  await runImplement({}, plan, null, 'tag', null);

  const parIdx1 = calls.findIndex((c) => c.label === 'tag:par:P1');
  const parIdx2 = calls.findIndex((c) => c.label === 'tag:par:P2');
  const serialIdx = calls.findIndex((c) => c.label === 'tag:serial:S1');

  assert.notStrictEqual(parIdx1, -1, 'tag:par:P1 の呼び出しが観測されない');
  assert.notStrictEqual(parIdx2, -1, 'tag:par:P2 の呼び出しが観測されない');
  assert.notStrictEqual(serialIdx, -1, 'tag:serial:S1 の呼び出しが観測されない');

  assert.ok(
    parIdx1 < serialIdx,
    `tag:par:P1（index=${parIdx1}）は tag:serial:S1（index=${serialIdx}）より先に呼ばれるべき`,
  );
  assert.ok(
    parIdx2 < serialIdx,
    `tag:par:P2（index=${parIdx2}）は tag:serial:S1（index=${serialIdx}）より先に呼ばれるべき`,
  );
});

test('[implement-order-failopen] VM: serial task の throw は reject せず null に落ち、parallel 結果は保持される', async () => {
  const { ctx, logs } = makeSandbox({ throwOnLabel: 'tag:serial:S1' });
  const runImplement = loadRunImplement(ctx);

  const plan = {
    serial: [{ id: 'S1' }],
    parallel: [{ id: 'P1' }, { id: 'P2' }],
  };

  const results = await runImplement({}, plan, null, 'tag', null);

  const s1Result = results.find((r) => r.task_id === 'tag:serial:S1');
  const p1Result = results.find((r) => r.task_id === 'tag:par:P1');
  const p2Result = results.find((r) => r.task_id === 'tag:par:P2');

  assert.strictEqual(s1Result, undefined, 'throw した serial task S1 の結果が返り値から欠落しているはず');
  assert.ok(p1Result, 'parallel task P1 の結果は返り値に含まれるはず');
  assert.ok(p2Result, 'parallel task P2 の結果は返り値に含まれるはず');

  assert.ok(
    logs.some((l) => l.includes('serial') || l.includes('S1')),
    `serial 失敗の fail-open 警告 log が記録されていない。logs: ${JSON.stringify(logs)}`,
  );
});

test('[implement-order-failopen] VM: plan.serial / plan.parallel が undefined でも空配列を返す', async () => {
  const { ctx } = makeSandbox();
  const runImplement = loadRunImplement(ctx);

  const results = await runImplement({}, {}, null, 'tag', null);

  // vm context の Array は Node 側 realm の Array と異なるため deepStrictEqual の
  // reference 比較を避け、length/要素で構造的に検証する（cross-realm 比較の既知の落とし穴）。
  assert.strictEqual(results.length, 0, `空配列を期待したが length=${results.length}`);
});
