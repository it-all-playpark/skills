import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyLiteReview } from './lite-route.mjs';

test('review が null → escalate:true（safety fail）', () => {
  const result = classifyLiteReview(null);
  assert.equal(result.escalate, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.minor, []);
});

test('review が undefined → escalate:true（safety fail）', () => {
  const result = classifyLiteReview(undefined);
  assert.equal(result.escalate, true);
});

test('approve + issues:undefined → escalate:false（Array.isArray ガードで空扱い）', () => {
  const result = classifyLiteReview({ decision: 'approve', issues: undefined });
  assert.equal(result.escalate, false);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.minor, []);
});

test('comment + issues:[] → escalate:false', () => {
  const result = classifyLiteReview({ decision: 'comment', issues: [] });
  assert.equal(result.escalate, false);
  assert.deepEqual(result.blocking, []);
});

test('request-changes + [minor] → escalate:false かつ minor.length===1', () => {
  const minor = { severity: 'minor', description: 'm' };
  const result = classifyLiteReview({ decision: 'request-changes', issues: [minor] });
  assert.equal(result.escalate, false);
  assert.deepEqual(result.blocking, []);
  assert.equal(result.minor.length, 1);
  assert.deepEqual(result.minor, [minor]);
});

test('comment + [major] → escalate:true かつ blocking.length===1（decision 非依存）', () => {
  const major = { severity: 'major', description: 'maj' };
  const result = classifyLiteReview({ decision: 'comment', issues: [major] });
  assert.equal(result.escalate, true);
  assert.equal(result.blocking.length, 1);
  assert.deepEqual(result.blocking, [major]);
});

test('approve + [critical] → escalate:true（contract mismatch も blocking>0 で escalate）', () => {
  const critical = { severity: 'critical', description: 'c' };
  const result = classifyLiteReview({ decision: 'approve', issues: [critical] });
  assert.equal(result.escalate, true);
  assert.equal(result.blocking.length, 1);
  assert.deepEqual(result.blocking, [critical]);
});
