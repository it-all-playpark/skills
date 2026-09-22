import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as triviality from './triviality.mjs';
import { classifyShape } from './triviality.mjs';

// classifyShape(req, realizedCount): 実効 shape は realized file 数 + issue 由来の決定論特徴量
// （AC 数 / issue_type / 構造化 breaking_change）だけで決まる（issue #676）。
// 事前見積もり（req.shape / req.estimated_change_file_count）は入力にならない。

const baseReq = (over = {}) => ({
  summary: 'fix a bug in foo',
  acceptance_criteria: ['x', 'y'],
  issue_type: 'fix',
  scope: 'src/foo.ts',
  ...over,
});

// ---- realized count 入力での micro / standard / complex 判定 ----

test('realized=1, ac=2, type=fix, no breaking → shape=micro', () => {
  const result = classifyShape(baseReq(), 1);
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /realized 1 file\(s\)/);
});

test('realized=2, ac=4, type=fix → shape=micro (issue #272 floor 緩和の境界)', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['a', 'b', 'c', 'd'] }), 2);
  assert.equal(result.shape, 'micro');
});

test('realized=0（変更 0 件）, ac=2 → shape=micro', () => {
  const result = classifyShape(baseReq(), 0);
  assert.equal(result.shape, 'micro');
});

test('realized=3, ac=2, type=feat → shape=standard', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 3);
  assert.equal(result.shape, 'standard');
  assert.match(result.reason, /realized 3 file\(s\), 2 AC, type=feat → shape=standard/);
});

test('realized=2, ac=5, type=fix → shape=standard (AC 数で micro 境界の 1 個外)', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['a', 'b', 'c', 'd', 'e'] }), 2);
  assert.equal(result.shape, 'standard');
});

test('realized=5, ac=6, type=feat → shape=standard (standard 境界上限)', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat', acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f'] }), 5);
  assert.equal(result.shape, 'standard');
});

test('realized=6, ac=2, type=feat → shape=complex', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 6);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /realized 6 file\(s\)/);
});

test('realized=3, ac=7, type=feat → shape=complex (ac>6)', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat', acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), 3);
  assert.equal(result.shape, 'complex');
});

// ---- count 欠損 → complex（changed-files probe 失敗の安全弁）----

test('realizedCount=NaN → shape=complex, reason に missing/safe', () => {
  const result = classifyShape(baseReq(), NaN);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

test('realizedCount 未指定(undefined) → shape=complex', () => {
  const result = classifyShape(baseReq(), undefined);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

test('realizedCount=-1 → shape=complex', () => {
  const result = classifyShape(baseReq(), -1);
  assert.equal(result.shape, 'complex');
});

test("realizedCount が文字列 '1' (型不正) → shape=complex", () => {
  const result = classifyShape(baseReq(), '1');
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

// ---- breaking_change=true → complex（realized が小さくても floor）----

test('breaking_change=true, realized=1, ac=1 → shape=complex, reason に analyze structured', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['x'], breaking_change: true, breaking_keyword_scan: false }), 1);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /analyze structured breaking_change=true/);
});

test('breaking_change と breaking_keyword_scan 両方 true → shape=complex, reason に両由来', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['x'], breaking_change: true, breaking_keyword_scan: true }), 1);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /analyze structured breaking_change=true/);
  assert.match(result.reason, /keyword scan hit/);
});

test('breaking_keyword_scan=true のみ (breaking_change=false) → keyword-alone は floor 不採用 (issue #364)', () => {
  const result = classifyShape(baseReq({ breaking_change: false, breaking_keyword_scan: true }), 1);
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /keyword/);
  assert.match(result.reason, /不採用/);
});

test('breaking_change / breaking_keyword_scan 未指定 → 非 breaking (realized/ac 由来の shape)', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['x'] }), 1);
  assert.equal(result.shape, 'micro');
  assert.ok(!/breaking/i.test(result.reason), `reason should not mention breaking, got: ${result.reason}`);
});

test('scope / summary に breaking 文言があっても両 flag false → complex にならない (PR #277 regression)', () => {
  const result = classifyShape(baseReq({
    acceptance_criteria: ['x'], scope: 'breaking change in API', summary: '破壊的変更を避けるための修正',
    breaking_change: false, breaking_keyword_scan: false,
  }), 1);
  assert.equal(result.shape, 'micro');
});

// ---- issue_type / acceptance_criteria の floor ----

test("issue_type='style' (enum 外) → shape=complex", () => {
  const result = classifyShape(baseReq({ issue_type: 'style' }), 1);
  assert.equal(result.shape, 'complex');
});

for (const issueType of ['feat', 'fix', 'docs', 'refactor', 'chore', 'test', 'perf', 'ci']) {
  test(`issue_type='${issueType}', realized=1, ac=2, no breaking → shape=micro`, () => {
    const result = classifyShape(baseReq({ issue_type: issueType, breaking_change: false }), 1);
    assert.equal(result.shape, 'micro');
  });
}

test('acceptance_criteria が null → shape=complex, reason に missing/safe', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: null }), 1);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

test('acceptance_criteria 欠落 → shape=complex', () => {
  const req = baseReq();
  delete req.acceptance_criteria;
  assert.equal(classifyShape(req, 1).shape, 'complex');
});

// ---- 事前見積もりは入力にならない（issue #676）----

test("req.shape='complex' があっても realized=1/ac=2 なら shape=micro（LLM raise 廃止）", () => {
  const result = classifyShape(baseReq({ shape: 'complex' }), 1);
  assert.equal(result.shape, 'micro');
  assert.ok(!/raise|LLM/i.test(result.reason), `reason should not mention LLM raise, got: ${result.reason}`);
});

test("req.shape='micro' があっても realized=6 なら shape=complex（lower も無い）", () => {
  const result = classifyShape(baseReq({ shape: 'micro' }), 6);
  assert.equal(result.shape, 'complex');
});

test('req.estimated_change_file_count=7 があっても realized=1 なら shape=micro（見積もりは無視）', () => {
  const result = classifyShape(baseReq({ estimated_change_file_count: 7 }), 1);
  assert.equal(result.shape, 'micro');
});

test('req.estimated_change_file_count=1 があっても realizedCount 欠損なら shape=complex（見積もりで補完しない）', () => {
  const result = classifyShape(baseReq({ estimated_change_file_count: 1 }), NaN);
  assert.equal(result.shape, 'complex');
});

test('refloorShape / mergeShape / SHAPE_RANK は export されない（realized 一本化、issue #676）', () => {
  assert.equal('refloorShape' in triviality, false);
  assert.equal('mergeShape' in triviality, false);
  assert.equal('SHAPE_RANK' in triviality, false);
  assert.deepEqual(Object.keys(triviality).sort(), ['classifyShape']);
});
