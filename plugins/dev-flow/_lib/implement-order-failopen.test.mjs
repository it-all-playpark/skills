// runImplement の実行順（parallel → serial）と fail-open 化を source + VM の 2 層で pin する
// （issue #534 で確立、issue #332 で parallel fan-out を pipeline() へ移行）。
//
// 背景（issue #534）:
//   従来の runImplement は plan.serial を先に順次実行し、plan.parallel を後に fan-out していた。
//   dev-planner の定義（serial=依存あり / parallel=独立）と整合させるには、独立している parallel を
//   先に実行し、serial がその成果物に依存できるようにする必要がある（AC-1）。
//   また serial 側は trackedAgent を直接呼んでおり、implementer が throw すると run 全体が abort
//   していた。parallel 側と同様に failOpenAgent（throw→null 吸収）へ合流させる（AC-2）。
//
// 背景（issue #332）:
//   parallel 側の fan-out を独自 parallel(thunks) から harness-native の pipeline(items, callback) へ
//   移行した。pipeline() は canary 実測契約（Claude Code 2.1.252、issue #325/#560 canary）により
//   callback の throw / null return を reject せず per-item null で resolve する — 独自 fail-open
//   ラップを追加しなくても従来と同じ「throw→null」契約を維持できる。
//
// このテストは:
//   層 1 (source pin):
//     runImplement 窓（`async function runImplement` から次の `// ====...` 区切りまで）に対して:
//       (a) 窓内で 'await pipeline(' の index が 'for (const t of (plan.serial' の index より小さい
//           （parallel fan-out 先行の実行順）
//       (b) 窓内に 'failOpenAgent(' が含まれる（serial fail-open 化）
//       (c) 窓長 > 100（窓ズレ検出）
//       (d) 窓内に 'parallel(' が残存しない（production parallel() 除去の pin。issue #332 AC-10）
//   層 2 (VM 動作検証):
//     窓ソースを vm.runInContext で評価し、stub agent/pipeline/log を注入して:
//       (e) plan.serial + plan.parallel を含む plan で、parallel 呼び出しが serial 呼び出しより先に
//           観測される（実行順の直接観測）
//       (f) serial task が throw しても runImplement は reject せず resolve し、
//           返り値から throw した serial task の結果が欠落し、parallel task の結果は含まれ、
//           fail-open の警告 log が記録される
//       (g) plan.serial / plan.parallel が undefined でも例外なく空配列を返す
//       (h) parallel task 0 件で pipeline 結果空・警告 log なし
//       (i) parallel task 1 件で結果が対応する task に一致する
//       (j) parallel 複数 task で throw した task の id のみ drop 警告 log に含まれ、他 task の結果は
//           入力順で保持される（results[i] ↔ items[i] の対応が入力順ずれで別 task に集約されないこと）
//       (k) parallel task の callback throw で runImplement が reject せず resolve する（canary 契約一致）
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

test('[implement-order-failopen] source: pipeline fan-out が serial ループより先に実行される', () => {
  const pipeIdx = runImplementWindow.indexOf('await pipeline(');
  const serialIdx = runImplementWindow.indexOf('for (const t of (plan.serial');

  assert.notStrictEqual(pipeIdx, -1, "runImplement 窓に 'await pipeline(' が見つからない");
  assert.notStrictEqual(serialIdx, -1, "runImplement 窓に 'for (const t of (plan.serial' が見つからない");
  assert.ok(
    pipeIdx < serialIdx,
    `pipeline fan-out（index=${pipeIdx}）が serial ループ（index=${serialIdx}）より先に実行されるべき`
    + '（issue #534 AC-1: parallel は独立しているため先行実行、serial はその成果に依存し得る。'
    + 'issue #332 で fan-out 手段は pipeline() へ移行したが順序は不変）',
  );
});

test('[implement-order-failopen] source: production parallel() が窓内から除去されている（issue #332 AC-10）', () => {
  assert.ok(
    !runImplementWindow.includes('parallel('),
    "runImplement 窓に 'parallel(' が残存している。parallel fan-out は pipeline(items, callback) へ"
    + ' 移行済みで、production parallel() 呼び出しは除去されているべき（issue #332 AC-10）',
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
 * runImplement 窓ソースを vm sandbox で評価する。stub agent/pipeline/log を注入する。
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

  // pipeline() stub: canary 実測契約（Claude Code 2.1.252、issue #325/#560 canary）準拠。
  // (1) 結果配列は入力順に対応（results[i] ↔ items[i]）
  // (2) callback が throw しても pipeline 全体は reject せず当該 item の結果を null にする
  // (3) callback が null/undefined を返した item は null になる
  // parallel stub は意図的に注入しない — runImplement が parallel(...) を参照したら
  // ReferenceError で fail し、production parallel() への回帰を検知する（issue #332 AC-10）。
  const pipelineStub = (items, cb) => Promise.all((items || []).map(async (item, i) => {
    try {
      const r = await cb(item, i);
      return r === undefined ? null : r;
    } catch {
      return null;
    }
  }));
  const implPromptStub = (t) => `p:${t.id}`;
  const logStub = (msg) => logs.push(msg);

  const ctx = vm.createContext({
    trackedAgent: trackedAgentStub,
    failOpenAgent: failOpenAgentStub,
    pipeline: pipelineStub,
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

test('[implement-order-failopen] VM: parallel task 0 件で pipeline 結果空・警告 log なし', async () => {
  const { ctx, calls, logs } = makeSandbox();
  const runImplement = loadRunImplement(ctx);

  const plan = { parallel: [], serial: [] };
  const results = await runImplement({}, plan, null, 'tag', null);

  assert.strictEqual(results.length, 0, `空配列を期待したが length=${results.length}`);
  assert.strictEqual(calls.length, 0, 'parallel task 0 件なのに agent 呼び出しが発生している');
  assert.ok(
    !logs.some((l) => l.includes('parallel implementer')),
    `parallel task 0 件なのに parallel drop 警告 log が出力されている。logs: ${JSON.stringify(logs)}`,
  );
});

test('[implement-order-failopen] VM: parallel task 1 件で結果が対応する task に一致する', async () => {
  const { ctx } = makeSandbox();
  const runImplement = loadRunImplement(ctx);

  const plan = { parallel: [{ id: 'P1' }], serial: [] };
  const results = await runImplement({}, plan, null, 'tag', null);

  assert.strictEqual(results.length, 1, `結果 1 件を期待したが length=${results.length}`);
  assert.strictEqual(results[0].task_id, 'tag:par:P1', 'results[0] が task P1 に対応していない');
});

test('[implement-order-failopen] VM: parallel 複数 task で throw した task の id のみ drop 警告 log に含まれ、他 task の結果は入力順で保持される', async () => {
  const { ctx, logs } = makeSandbox({ throwOnLabel: 'tag:par:P2' });
  const runImplement = loadRunImplement(ctx);

  const plan = {
    parallel: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }],
    serial: [],
  };

  const results = await runImplement({}, plan, null, 'tag', null);

  const p1Result = results.find((r) => r.task_id === 'tag:par:P1');
  const p2Result = results.find((r) => r.task_id === 'tag:par:P2');
  const p3Result = results.find((r) => r.task_id === 'tag:par:P3');

  assert.ok(p1Result, 'throw していない task P1 の結果は返り値に含まれるはず（入力順ずれで欠落してはならない）');
  assert.strictEqual(p2Result, undefined, 'throw した task P2 の結果は返り値から欠落しているはず');
  assert.ok(p3Result, 'throw していない task P3 の結果は返り値に含まれるはず（入力順ずれで欠落してはならない）');

  assert.ok(
    logs.some((l) => l.includes('parallel implementer') && l.includes('(dropped: P2)')),
    `parallel drop 警告 log に throw した task の id（P2）が正しい形式で含まれていない。logs: ${JSON.stringify(logs)}`,
  );
  assert.ok(
    !logs.some((l) => l.includes('dropped:') && (l.includes('P1') || l.includes('P3'))),
    `drop していない task（P1/P3）の id が drop 警告 log に混入している（入力順対応の誤りを示す）。logs: ${JSON.stringify(logs)}`,
  );
});

test('[implement-order-failopen] VM: parallel task の callback throw で runImplement が reject せず resolve する（canary 契約一致）', async () => {
  const { ctx } = makeSandbox({ throwOnLabel: 'tag:par:P1' });
  const runImplement = loadRunImplement(ctx);

  const plan = { parallel: [{ id: 'P1' }], serial: [] };

  await assert.doesNotReject(
    () => runImplement({}, plan, null, 'tag', null),
    'parallel task の callback throw で runImplement が reject してはならない'
    + '（pipeline() の canary 契約: callback throw は per-item null に落ち reject しない）',
  );
});
