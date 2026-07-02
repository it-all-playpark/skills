import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShape, SHAPE_RANK } from './triviality.mjs';

// (a) micro 適格: count<=2, ac<=3, type=fix, no breaking → shape='micro'
test('micro 適格: count=1, ac=2, type=fix, no breaking → shape=micro', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug in foo',
  });
  assert.equal(result.shape, 'micro');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason should not be empty');
});

// (b) count=3 の中規模 → shape='standard'
test('count=3, ac=2, type=feat → shape=standard', () => {
  const result = classifyShape({
    estimated_change_file_count: 3,
    acceptance_criteria: ['a', 'b'],
    issue_type: 'feat',
    scope: 'src',
    summary: 'add feature',
  });
  assert.equal(result.shape, 'standard');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (c) ac=4 の micro floor 境界 → 'micro' (issue #272 floor 緩和)
test('count=2, ac=4, type=fix → shape=micro (issue #272 floor 緩和)', () => {
  const result = classifyShape({
    estimated_change_file_count: 2,
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix something',
  });
  assert.equal(result.shape, 'micro');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (c2) ac=5 → 'standard' (micro floor 境界の 1 個外)
test('count=2, ac=5, type=fix → shape=standard', () => {
  const result = classifyShape({
    estimated_change_file_count: 2,
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix something bigger',
  });
  assert.equal(result.shape, 'standard');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (c3) count=1, ac=4, type=docs → 'micro'
test('count=1, ac=4, type=docs → shape=micro', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'docs',
    scope: 'docs/foo.md',
    summary: 'update docs',
  });
  assert.equal(result.shape, 'micro');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (d) count 大 (>5) → 'complex'
test('count=6, ac=2, type=feat → shape=complex', () => {
  const result = classifyShape({
    estimated_change_file_count: 6,
    acceptance_criteria: ['a', 'b'],
    issue_type: 'feat',
    scope: 'src',
    summary: 'big feature',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (e) issue_type='chore' (enum 外) → 'complex'
test("issue_type='chore' (enum 外) → shape=complex", () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'chore',
    scope: 'src/foo.ts',
    summary: 'chore something',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (f) regression (PR #277 相当): scope に breaking 文言があるが breaking_change/breaking_keyword_scan
// が両方 false → 自由文言及だけでは floor 不発火 (complex にならない)
test('PR#277 regression: scope に breaking 文言があるが両 flag false → complex にならない', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'breaking change in API',
    summary: 'fix a bug',
    breaking_change: false,
    breaking_keyword_scan: false,
  });
  assert.equal(result.shape, 'micro');
});

// (f2) breaking_change=true のみ → shape=complex, reason に 'analyze structured' 由来を明記
test('breaking_change=true のみ → shape=complex, reason に analyze structured', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix a bug',
    breaking_change: true,
    breaking_keyword_scan: false,
  });
  assert.equal(result.shape, 'complex');
  assert.ok(
    /analyze structured/.test(result.reason),
    `reason should mention analyze structured, got: ${result.reason}`
  );
});

// (f3) breaking_keyword_scan=true のみ → shape=complex, reason に 'keyword scan' 由来を明記
test('breaking_keyword_scan=true のみ → shape=complex, reason に keyword scan', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix a bug',
    breaking_change: false,
    breaking_keyword_scan: true,
  });
  assert.equal(result.shape, 'complex');
  assert.ok(
    /keyword scan/.test(result.reason),
    `reason should mention keyword scan, got: ${result.reason}`
  );
});

// (f4) 両 flag true → shape=complex, reason に両由来を明記
test('breaking_change と breaking_keyword_scan 両方 true → shape=complex, reason に両由来', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix a bug',
    breaking_change: true,
    breaking_keyword_scan: true,
  });
  assert.equal(result.shape, 'complex');
  assert.ok(
    /analyze structured/.test(result.reason),
    `reason missing analyze structured, got: ${result.reason}`
  );
  assert.ok(
    /keyword scan/.test(result.reason),
    `reason missing keyword scan, got: ${result.reason}`
  );
});

// (f5) 両 field 未指定(undefined) → 非 breaking (=== true 判定のため欠落は false 扱い)、count/ac 由来の floor
test('breaking_change / breaking_keyword_scan 未指定 → 非 breaking (count/ac 由来の floor)', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix a bug',
  });
  assert.equal(result.shape, 'micro');
  assert.ok(!/breaking/i.test(result.reason), `reason should not mention breaking, got: ${result.reason}`);
});

// (f6) summary に破壊的変更への言及があっても両 flag false なら complex にならない
test('summary に破壊的変更言及があるが両 flag false → complex にならない', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: '破壊的変更を避けるための修正',
    breaking_change: false,
    breaking_keyword_scan: false,
  });
  assert.equal(result.shape, 'micro');
});

// (g) estimated_change_file_count 欠落(undefined) → 'complex' かつ reason に 'missing'/'safe'
test('estimated_change_file_count 欠落 → shape=complex, reason に missing/safe', () => {
  const result = classifyShape({
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(
    /missing|safe/i.test(result.reason),
    `reason should contain 'missing' or 'safe', got: ${result.reason}`
  );
});

// (h) estimated_change_file_count が文字列 '1' (型不正) → 'complex' かつ reason に 'missing'/'safe'
test("estimated_change_file_count が文字列 '1' (型不正) → shape=complex, reason に missing/safe", () => {
  const result = classifyShape({
    estimated_change_file_count: '1',
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(
    /missing|safe/i.test(result.reason),
    `reason should contain 'missing' or 'safe', got: ${result.reason}`
  );
});

// (i) raise-only: floor='micro' だが req.shape='complex' → 'complex' (LLM raise 採用)
test("raise-only: floor=micro, req.shape='complex' → shape=complex (LLM raise)", () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix a small bug',
    shape: 'complex',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
  assert.ok(
    /raise|LLM/i.test(result.reason),
    `reason should indicate LLM raise, got: ${result.reason}`
  );
});

// (j) lower 禁止: floor='complex' だが req.shape='micro' → 'complex' のまま (LLM lower 無視)
test("lower 禁止: floor=complex, req.shape='micro' → shape=complex (LLM lower 無視)", () => {
  const result = classifyShape({
    estimated_change_file_count: 6,
    acceptance_criteria: ['a', 'b'],
    issue_type: 'feat',
    scope: 'src',
    summary: 'big feature',
    shape: 'micro',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (k) req.shape が不正キー 'huge' → floor をそのまま採用
test("req.shape が不正キー 'huge' → floor をそのまま採用 (micro)", () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'tiny fix',
    shape: 'huge',
  });
  assert.equal(result.shape, 'micro');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// SHAPE_RANK の値検証
test('SHAPE_RANK は micro=0, standard=1, complex=2 の定数', () => {
  assert.equal(SHAPE_RANK.micro, 0);
  assert.equal(SHAPE_RANK.standard, 1);
  assert.equal(SHAPE_RANK.complex, 2);
});

// ac=7 の大規模 → 'complex'
test('count=3, ac=7, type=feat → shape=complex (ac>6)', () => {
  const result = classifyShape({
    estimated_change_file_count: 3,
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    issue_type: 'feat',
    scope: 'src',
    summary: 'complex feature',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// count=2, ac=3 で boundary の micro 確認
test('count=2, ac=3 → shape=micro (boundary)', () => {
  const result = classifyShape({
    estimated_change_file_count: 2,
    acceptance_criteria: ['a', 'b', 'c'],
    issue_type: 'refactor',
    scope: 'src',
    summary: 'clean up',
  });
  assert.equal(result.shape, 'micro');
});

// count=5, ac=6 → standard (boundary upper)
test('count=5, ac=6, type=feat → shape=standard (boundary upper)', () => {
  const result = classifyShape({
    estimated_change_file_count: 5,
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f'],
    issue_type: 'feat',
    scope: 'src',
    summary: 'medium feature',
  });
  assert.equal(result.shape, 'standard');
});

// raise-only: floor='standard', req.shape='standard' → 'standard' (同じ rank は OK)
test("raise-only: floor=standard, req.shape='standard' → shape=standard (同 rank)", () => {
  const result = classifyShape({
    estimated_change_file_count: 3,
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'medium fix',
    shape: 'standard',
  });
  assert.equal(result.shape, 'standard');
});

// acceptance_criteria が配列でない → 'complex' かつ reason に 'missing'/'safe'
test('acceptance_criteria が null → shape=complex, reason に missing/safe', () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: null,
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix',
  });
  assert.equal(result.shape, 'complex');
  assert.ok(
    /missing|safe/i.test(result.reason),
    `reason should contain 'missing' or 'safe', got: ${result.reason}`
  );
});

// ---- refloorShape tests ----
import { refloorShape } from './triviality.mjs';

// (1) estimatedShape='micro' + realizedCount=6 → complex (count>5 なので complex floor), refloored=true
test('refloorShape: estimatedShape=micro, realizedCount=6 → shape=complex, refloored=true', () => {
  const result = refloorShape('micro', 6);
  assert.equal(result.shape, 'complex');
  assert.equal(result.refloored, true);
  assert.equal(result.realizedFloor, 'complex');
  assert.equal(result.realizedCount, 6);
});

// (2) estimatedShape='micro' + realizedCount=1 → micro (count<=2), refloored=false
test('refloorShape: estimatedShape=micro, realizedCount=1 → shape=micro, refloored=false', () => {
  const result = refloorShape('micro', 1);
  assert.equal(result.shape, 'micro');
  assert.equal(result.refloored, false);
  assert.equal(result.realizedFloor, 'micro');
  assert.equal(result.realizedCount, 1);
});

// (3) estimatedShape='standard' + realizedCount=6 → complex, refloored=true
test('refloorShape: estimatedShape=standard, realizedCount=6 → shape=complex, refloored=true', () => {
  const result = refloorShape('standard', 6);
  assert.equal(result.shape, 'complex');
  assert.equal(result.refloored, true);
  assert.equal(result.realizedFloor, 'complex');
  assert.equal(result.realizedCount, 6);
});

// (4) estimatedShape='complex' + realizedCount=1 → complex, refloored=false (raise-only: demote しない)
test('refloorShape: estimatedShape=complex, realizedCount=1 → shape=complex, refloored=false (raise-only)', () => {
  const result = refloorShape('complex', 1);
  assert.equal(result.shape, 'complex');
  assert.equal(result.refloored, false);
  assert.equal(result.realizedFloor, 'micro');
  assert.equal(result.realizedCount, 1);
});

// (5) realizedCount=NaN → realizedFloor='complex' (安全側)
test('refloorShape: realizedCount=NaN → realizedFloor=complex', () => {
  const result = refloorShape('micro', NaN);
  assert.equal(result.realizedFloor, 'complex');
  assert.equal(result.shape, 'complex');
  assert.equal(result.refloored, true);
});

// (5b) realizedCount=-1 → realizedFloor='complex' (安全側)
test('refloorShape: realizedCount=-1 → realizedFloor=complex', () => {
  const result = refloorShape('micro', -1);
  assert.equal(result.realizedFloor, 'complex');
  assert.equal(result.shape, 'complex');
  assert.equal(result.refloored, true);
});
