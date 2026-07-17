import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CLOCK_MARK_ORDER,
  CLOCK_PHASE_ENDS,
  clockProbePrompt,
  recordClockMark,
  computeDurations,
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

test('clockProbePrompt は文字列を返す', () => {
  const prompt = clockProbePrompt();
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /date \+%s/);
  assert.match(prompt, /ok/);
  assert.match(prompt, /epoch/);
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
