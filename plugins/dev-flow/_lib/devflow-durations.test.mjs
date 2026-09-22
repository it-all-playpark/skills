import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CLOCK_MARK_ORDER,
  CLOCK_PHASE_ENDS,
  recordClockMark,
  computeDurations,
  epochResOf,
  maxEpochRes,
} from './devflow-durations.mjs';

// ---- (0) constants ----

test('CLOCK_MARK_ORDER は probe 発火順の 9 mark 配列', () => {
  assert.deepEqual(CLOCK_MARK_ORDER, [
    'start',
    'setup_end',
    'implement_end',
    'validate_end',
    'evaluate_end',
    'pr_end',
    'iterate_end',
    'final_end',
    'end',
  ]);
});

test('CLOCK_PHASE_ENDS は 6 phase の [key, endMark] 配列', () => {
  assert.deepEqual(CLOCK_PHASE_ENDS, [
    ['implement', 'implement_end'],
    ['validate', 'validate_end'],
    ['evaluate', 'evaluate_end'],
    ['pr', 'pr_end'],
    ['iterate', 'iterate_end'],
    ['final', 'final_end'],
  ]);
});

// ---- (1) computeDurations: 全 mark 単調増加（10刻み） ----

function buildMonotonicMarks(step = 10) {
  const marks = {};
  CLOCK_MARK_ORDER.forEach((name, i) => {
    marks[name] = i * step;
  });
  return marks;
}

test('computeDurations: 全 mark 単調増加 → duration_seconds=80, 6 phase 全て =10', () => {
  const marks = buildMonotonicMarks(10);
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, 80);
  assert.deepEqual(result.phase_durations, {
    implement: 10,
    validate: 10,
    evaluate: 10,
    pr: 10,
    iterate: 10,
    final: 10,
  });
});

// ---- (2) computeDurations: 全 mark null ----

test('computeDurations: 全 mark null → duration_seconds=null, phase_durations={}', () => {
  const marks = {};
  CLOCK_MARK_ORDER.forEach((name) => {
    marks[name] = null;
  });
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, null);
  assert.deepEqual(result.phase_durations, {});
});

// ---- (3) computeDurations: evaluate_end のみ null ----

test('computeDurations: evaluate_end のみ null → evaluate キー欠落, pr は validate_end 起点', () => {
  const marks = buildMonotonicMarks(10);
  marks.evaluate_end = null;
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, 80);
  assert.ok(!('evaluate' in result.phase_durations));
  // pr_end(index5)=50, validate_end(index3)=30 -> pr = 20
  assert.equal(result.phase_durations.pr, 20);
  assert.equal(result.phase_durations.implement, 10);
  assert.equal(result.phase_durations.validate, 10);
  assert.equal(result.phase_durations.iterate, 10);
  assert.equal(result.phase_durations.final, 10);
});

// ---- (4) computeDurations: end - start が負 ----

test('computeDurations: end - start が負 → duration_seconds=null', () => {
  const marks = buildMonotonicMarks(10);
  marks.start = 200;
  marks.end = 100;
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, null);
});

// ---- (5) computeDurations: phase 終端間で負差 ----

test('computeDurations: phase 終端間で負差 → 当該キー省略', () => {
  const marks = buildMonotonicMarks(10);
  // implement_end (index2=20) を validate_end(index3=30) より後ろにする -> validate phase 負差
  marks.implement_end = 50;
  const result = computeDurations(marks);
  assert.ok(!('validate' in result.phase_durations));
  // implement phase: setup_end(10) -> implement_end(50) = 40 (正常)
  assert.equal(result.phase_durations.implement, 40);
});

// ---- (5b) issue #678 / #695: Plan / Analyze phase 撤去後、phase_durations に plan / analyze キーは出ない ----

test('computeDurations: marks に plan_end / analyze 系 mark が紛れ込んでも phase_durations に plan / analyze キーは出ない（issue #678 / #695）', () => {
  const marks = buildMonotonicMarks(10);
  marks.plan_end = 15;
  marks[['analyze', 'start'].join('_')] = 12;
  marks[['analyze', 'end'].join('_')] = 14;
  const result = computeDurations(marks);
  for (const key of ['plan', 'analyze']) {
    assert.ok(!(key in result.phase_durations), `phase_durations に ${key} が含まれている: ${JSON.stringify(result.phase_durations)}`);
    assert.ok(!CLOCK_PHASE_ENDS.some(([k]) => k === key), `CLOCK_PHASE_ENDS に ${key} が残っている`);
  }
  for (const mark of ['plan_end', ['analyze', 'start'].join('_'), ['analyze', 'end'].join('_')]) {
    assert.ok(!CLOCK_MARK_ORDER.includes(mark), `CLOCK_MARK_ORDER に ${mark} が残っている`);
  }
  // implement は setup_end(10) → implement_end(20) で plan_end / analyze 系 mark を経由しない
  assert.equal(result.phase_durations.implement, 10);
});

// ---- (5c) issue #695: implement の起点は setup_end（prerun の epoch_end）で、deps install（start〜setup_end）を含まない ----

test('computeDurations: implement は setup_end 起点 — start〜setup_end（deps install 等の prerun 決定論処理）を含まず、残差は duration_seconds − Σphase_durations に留まる（issue #695）', () => {
  // start=1000（deps install 前）、setup_end=1300（deps install に 300 秒）、implement_end=1400
  const marks = {
    start: 1000,
    setup_end: 1300,
    implement_end: 1400,
    validate_end: 1450,
    evaluate_end: null,
    pr_end: null,
    iterate_end: null,
    final_end: null,
    end: 1500,
  };
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, 500);
  assert.equal(result.phase_durations.implement, 100, 'implement に deps install の 300 秒が混入している');
  assert.equal(result.phase_durations.validate, 50);
  assert.ok(!('setup' in result.phase_durations), 'setup は phase_durations に出さない（残差に留める）');
  const sum = Object.values(result.phase_durations).reduce((a, b) => a + b, 0);
  assert.equal(result.duration_seconds - sum, 350, 'deps install（300）+ 末尾（50）が残差になるべき');
});

test('computeDurations: setup_end が null（給電失敗）なら implement は start 起点へ fail-open で倒れる', () => {
  const marks = { start: 1000, setup_end: null, implement_end: 1400, end: 1500 };
  const result = computeDurations(marks);
  assert.equal(result.phase_durations.implement, 400);
});

// ---- (6) recordClockMark ----

test('recordClockMark: {ok:true, epoch:123} → marks 記録 + null 返却', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'start', { ok: true, epoch: 123 });
  assert.equal(warn, null);
  assert.equal(marks.start, 123);
});

test('recordClockMark: null → marks[name]=null + 警告文字列', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'end', null);
  assert.equal(marks.end, null);
  assert.equal(warn, '⚠️ clock#end の取得に失敗 — duration telemetry は当該区間を欠落させる（fail-open）');
});

test('recordClockMark: {ok:false} → marks[name]=null + 警告文字列', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'setup_end', { ok: false });
  assert.equal(marks.setup_end, null);
  assert.match(warn, /clock#setup_end/);
});

test('recordClockMark: {ok:true, epoch:"x"} → marks[name]=null + 警告文字列', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'evaluate_end', { ok: true, epoch: 'x' });
  assert.equal(marks.evaluate_end, null);
  assert.match(warn, /clock#evaluate_end/);
});

test('recordClockMark: {ok:true, epoch:NaN} → marks[name]=null + 警告文字列', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'implement_end', { ok: true, epoch: NaN });
  assert.equal(marks.implement_end, null);
  assert.match(warn, /clock#implement_end/);
});

// ---- (7) computeDurations: start 欠落 + setup_end/implement_end あり ----

test('computeDurations: start 欠落 → duration_seconds=null だが implement は計算される', () => {
  const marks = buildMonotonicMarks(10);
  marks.start = null;
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, null);
  assert.equal(result.phase_durations.implement, 10);
});

// ---- (8) epochResOf ----

test('epochResOf: 有限数値の epoch を持つ object → {ok:true, epoch}', () => {
  assert.deepEqual(epochResOf({ epoch: 123 }), { ok: true, epoch: 123 });
});

test('epochResOf: ok:false でも epoch が有限数値なら採用する', () => {
  assert.deepEqual(epochResOf({ ok: false, epoch: 456 }), { ok: true, epoch: 456 });
});

test('epochResOf: null → null', () => {
  assert.equal(epochResOf(null), null);
});

test('epochResOf: undefined → null', () => {
  assert.equal(epochResOf(undefined), null);
});

test('epochResOf: {} (epoch 欠落) → null', () => {
  assert.equal(epochResOf({}), null);
});

test('epochResOf: {epoch:"x"} (非数値) → null', () => {
  assert.equal(epochResOf({ epoch: 'x' }), null);
});

test('epochResOf: {epoch:NaN} → null', () => {
  assert.equal(epochResOf({ epoch: NaN }), null);
});

test('epochResOf: {epoch:Infinity} → null', () => {
  assert.equal(epochResOf({ epoch: Infinity }), null);
});

test('epochResOf: 非 object（number）→ null', () => {
  assert.equal(epochResOf(123), null);
});

// ---- (9) maxEpochRes ----

test('maxEpochRes: 空配列 → null', () => {
  assert.equal(maxEpochRes([]), null);
});

test('maxEpochRes: 全 null 要素 → null', () => {
  assert.equal(maxEpochRes([null, null]), null);
});

test('maxEpochRes: 混在配列 → 最大 epoch の {ok:true, epoch}', () => {
  const list = [
    epochResOf({ epoch: 10 }),
    null,
    epochResOf({ epoch: 30 }),
    epochResOf({ epoch: 20 }),
  ];
  assert.deepEqual(maxEpochRes(list), { ok: true, epoch: 30 });
});

test('maxEpochRes: 非配列 → null', () => {
  assert.equal(maxEpochRes(null), null);
  assert.equal(maxEpochRes(undefined), null);
  assert.equal(maxEpochRes({}), null);
  assert.equal(maxEpochRes('not-an-array'), null);
});

// ---- (10) fail-open: epochResOf(null) を recordClockMark へ通す給電失敗経路 ----

test('recordClockMark(marks, name, epochResOf(null)) → mark null + 警告文字列（fail-open 不変）', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'pr_end', epochResOf(null));
  assert.equal(marks.pr_end, null);
  assert.match(warn, /clock#pr_end/);
});

// ---- (11) computeDurations の出力キー語彙は epochResOf/maxEpochRes 給電後も不変 ----

test('computeDurations: epochResOf/maxEpochRes で給電した marks でも出力キーは duration_seconds + phase_durations（6 phase）のまま', () => {
  const marks = {};
  CLOCK_MARK_ORDER.forEach((name, i) => {
    const res = epochResOf({ epoch: i * 10 });
    recordClockMark(marks, name, res);
  });
  const result = computeDurations(marks);
  assert.deepEqual(Object.keys(result).sort(), ['duration_seconds', 'phase_durations']);
  assert.deepEqual(Object.keys(result.phase_durations).sort(), [
    'evaluate',
    'final',
    'implement',
    'iterate',
    'pr',
    'validate',
  ]);
});
