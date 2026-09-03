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

test('CLOCK_MARK_ORDER は probe 発火順の 11 mark 配列', () => {
  assert.deepEqual(CLOCK_MARK_ORDER, [
    'start',
    'analyze_start',
    'analyze_end',
    'plan_end',
    'implement_end',
    'validate_end',
    'evaluate_end',
    'pr_end',
    'iterate_end',
    'final_end',
    'end',
  ]);
});

test('CLOCK_PHASE_ENDS は 8 phase の [key, endMark] 配列', () => {
  assert.deepEqual(CLOCK_PHASE_ENDS, [
    ['analyze', 'analyze_end'],
    ['plan', 'plan_end'],
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

test('computeDurations: 全 mark 単調増加 → duration_seconds=100, 8 phase 全て =10', () => {
  const marks = buildMonotonicMarks(10);
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, 100);
  assert.deepEqual(result.phase_durations, {
    analyze: 10,
    plan: 10,
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
  assert.equal(result.duration_seconds, 100);
  assert.ok(!('evaluate' in result.phase_durations));
  // pr_end(index7)=70, validate_end(index5)=50 -> pr = 20
  assert.equal(result.phase_durations.pr, 20);
  assert.equal(result.phase_durations.analyze, 10);
  assert.equal(result.phase_durations.plan, 10);
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
  // plan_end (index3=30) を implement_end(index4=40) より後ろにする -> implement phase 負差
  marks.plan_end = 50;
  const result = computeDurations(marks);
  assert.ok(!('implement' in result.phase_durations));
  // plan phase: analyze_end(20) -> plan_end(50) = 30 (正常)
  assert.equal(result.phase_durations.plan, 30);
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
  const warn = recordClockMark(marks, 'analyze_start', { ok: false });
  assert.equal(marks.analyze_start, null);
  assert.match(warn, /clock#analyze_start/);
});

test('recordClockMark: {ok:true, epoch:"x"} → marks[name]=null + 警告文字列', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'plan_end', { ok: true, epoch: 'x' });
  assert.equal(marks.plan_end, null);
  assert.match(warn, /clock#plan_end/);
});

test('recordClockMark: {ok:true, epoch:NaN} → marks[name]=null + 警告文字列', () => {
  const marks = {};
  const warn = recordClockMark(marks, 'implement_end', { ok: true, epoch: NaN });
  assert.equal(marks.implement_end, null);
  assert.match(warn, /clock#implement_end/);
});

// ---- (7) computeDurations: start 欠落 + analyze_start/analyze_end あり ----

test('computeDurations: start 欠落 → duration_seconds=null だが analyze は計算される', () => {
  const marks = buildMonotonicMarks(10);
  marks.start = null;
  const result = computeDurations(marks);
  assert.equal(result.duration_seconds, null);
  assert.equal(result.phase_durations.analyze, 10);
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
  const warn = recordClockMark(marks, 'plan_end', epochResOf(null));
  assert.equal(marks.plan_end, null);
  assert.match(warn, /clock#plan_end/);
});

// ---- (11) computeDurations の出力キー語彙は epochResOf/maxEpochRes 給電後も不変 ----

test('computeDurations: epochResOf/maxEpochRes で給電した marks でも出力キーは duration_seconds + phase_durations（8 phase）のまま', () => {
  const marks = {};
  CLOCK_MARK_ORDER.forEach((name, i) => {
    const res = epochResOf({ epoch: i * 10 });
    recordClockMark(marks, name, res);
  });
  const result = computeDurations(marks);
  assert.deepEqual(Object.keys(result).sort(), ['duration_seconds', 'phase_durations']);
  assert.deepEqual(Object.keys(result.phase_durations).sort(), [
    'analyze',
    'evaluate',
    'final',
    'implement',
    'iterate',
    'plan',
    'pr',
    'validate',
  ]);
});
