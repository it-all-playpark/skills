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

// (c) ac=4 の中規模 → 'standard'
test('count=2, ac=4, type=fix → shape=standard', () => {
  const result = classifyShape({
    estimated_change_file_count: 2,
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'fix',
    scope: 'src',
    summary: 'fix something',
  });
  assert.equal(result.shape, 'standard');
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

// (f) scope に 'breaking change' → 'complex'
test("scope に 'breaking change' を含む → shape=complex", () => {
  const result = classifyShape({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'breaking change in API',
    summary: 'fix a bug',
  });
  assert.equal(result.shape, 'complex');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
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
