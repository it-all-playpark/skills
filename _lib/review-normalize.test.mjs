import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReviewRoute,
  REVIEW_ROUTE_CI_GATE,
  REVIEW_ROUTE_FIX_LOOP,
  REVIEW_ROUTE_CONTRACT_MISMATCH,
} from './review-normalize.mjs';

test('approve + issues:[] → ci_gate / blocking 0 / minor 0', () => {
  const result = classifyReviewRoute({ decision: 'approve', issues: [] });
  assert.equal(result.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.minor, []);
});

test('comment + minor のみ 2 件 → ci_gate / minor 2 件がそのまま返る', () => {
  const minorA = { severity: 'minor', description: 'a' };
  const minorB = { severity: 'minor', description: 'b' };
  const result = classifyReviewRoute({ decision: 'comment', issues: [minorA, minorB] });
  assert.equal(result.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.minor, [minorA, minorB]);
});

test('request-changes + issues:[] → ci_gate', () => {
  const result = classifyReviewRoute({ decision: 'request-changes', issues: [] });
  assert.equal(result.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(result.blocking, []);
});

test('approve + [major] → contract_mismatch / blocking 1', () => {
  const major = { severity: 'major', description: 'm' };
  const result = classifyReviewRoute({ decision: 'approve', issues: [major] });
  assert.equal(result.route, REVIEW_ROUTE_CONTRACT_MISMATCH);
  assert.deepEqual(result.blocking, [major]);
});

test('approve + [critical, minor] → contract_mismatch / blocking 1 / minor 1', () => {
  const critical = { severity: 'critical', description: 'c' };
  const minor = { severity: 'minor', description: 'n' };
  const result = classifyReviewRoute({ decision: 'approve', issues: [critical, minor] });
  assert.equal(result.route, REVIEW_ROUTE_CONTRACT_MISMATCH);
  assert.deepEqual(result.blocking, [critical]);
  assert.deepEqual(result.minor, [minor]);
});

test('request-changes + [major, minor] → fix_loop / blocking 1 / minor 1', () => {
  const major = { severity: 'major', description: 'm' };
  const minor = { severity: 'minor', description: 'n' };
  const result = classifyReviewRoute({ decision: 'request-changes', issues: [major, minor] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [major]);
  assert.deepEqual(result.minor, [minor]);
});

test('comment + [critical] → fix_loop', () => {
  const critical = { severity: 'critical', description: 'c' };
  const result = classifyReviewRoute({ decision: 'comment', issues: [critical] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [critical]);
});

test('issues が undefined / review が null → ci_gate / 空配列（throw しない）', () => {
  const resultUndefinedIssues = classifyReviewRoute({ decision: 'approve' });
  assert.equal(resultUndefinedIssues.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(resultUndefinedIssues.blocking, []);
  assert.deepEqual(resultUndefinedIssues.minor, []);

  const resultNullReview = classifyReviewRoute(null);
  assert.equal(resultNullReview.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(resultNullReview.blocking, []);
  assert.deepEqual(resultNullReview.minor, []);
});

test('critical と major の混在が両方 blocking に入る', () => {
  const critical = { severity: 'critical', description: 'c' };
  const major = { severity: 'major', description: 'm' };
  const result = classifyReviewRoute({ decision: 'request-changes', issues: [critical, major] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [critical, major]);
});
