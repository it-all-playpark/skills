import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTriviality } from './triviality.mjs';

// (a) trivial 適格: 全条件成立 → trivial:true
test('trivial 適格: 全条件成立で trivial:true', () => {
  const result = classifyTriviality({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug in foo',
  });
  assert.equal(result.trivial, true);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason should not be empty');
});

// (b) estimated_change_file_count:3 → false
test('estimated_change_file_count:3 → trivial:false', () => {
  const result = classifyTriviality({
    estimated_change_file_count: 3,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug',
  });
  assert.equal(result.trivial, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (c) acceptance_criteria 4 件 → false
test('acceptance_criteria 4 件 → trivial:false', () => {
  const result = classifyTriviality({
    estimated_change_file_count: 1,
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug',
  });
  assert.equal(result.trivial, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (d) issue_type:'chore'(enum 外) → false
test("issue_type:'chore' (enum 外) → trivial:false", () => {
  const result = classifyTriviality({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'chore',
    scope: 'src/foo.ts',
    summary: 'chore something',
  });
  assert.equal(result.trivial, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (e) scope に 'breaking change' を含む → false
test("scope に 'breaking change' を含む → trivial:false", () => {
  const result = classifyTriviality({
    estimated_change_file_count: 1,
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'breaking change in API',
    summary: 'fix a bug',
  });
  assert.equal(result.trivial, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// (f) estimated_change_file_count 欠落(undefined) → false かつ reason に 'missing'/'safe' 系文言
test('estimated_change_file_count 欠落(undefined) → trivial:false, reason に missing/safe', () => {
  const result = classifyTriviality({
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug',
  });
  assert.equal(result.trivial, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(
    /missing|safe/i.test(result.reason),
    `reason should contain 'missing' or 'safe', got: ${result.reason}`
  );
});

// (g) estimated_change_file_count が文字列 '1'(型不正) → false
test("estimated_change_file_count が文字列 '1' (型不正) → trivial:false", () => {
  const result = classifyTriviality({
    estimated_change_file_count: '1',
    acceptance_criteria: ['x', 'y'],
    issue_type: 'fix',
    scope: 'src/foo.ts',
    summary: 'fix a bug',
  });
  assert.equal(result.trivial, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});
