// _lib/improve-hypothesis.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  IMPROVE_METRIC_DIRECTIONS,
  improveMetricNames,
  buildHypothesisBlock,
  parseHypothesisBlock,
  setHypothesisStatus,
} from './improve-hypothesis.mjs';

test('metric enum は 3 値 closed', () => {
  assert.deepEqual(Object.keys(IMPROVE_METRIC_DIRECTIONS).sort(), [
    'cap_pinned_count', 'iterate_unhealthy_rate', 'micro_share',
  ]);
  assert.equal(IMPROVE_METRIC_DIRECTIONS.iterate_unhealthy_rate, 'lte');
  assert.equal(IMPROVE_METRIC_DIRECTIONS.micro_share, 'gte');
  assert.deepEqual(improveMetricNames().sort(), Object.keys(IMPROVE_METRIC_DIRECTIONS).sort());
});

test('build → parse round-trip', () => {
  const block = buildHypothesisBlock({
    metric: 'iterate_unhealthy_rate', current: 0.31, target: 0.15, min_runs: 5,
  });
  const body = `## 背景\n本文\n\n${block}\n\n---\nfooter`;
  assert.deepEqual(parseHypothesisBlock(body), {
    metric: 'iterate_unhealthy_rate', current: 0.31, target: 0.15, min_runs: 5, status: 'pending',
  });
});

test('build: out-of-enum metric は throw', () => {
  assert.throws(
    () => buildHypothesisBlock({ metric: 'bogus', current: 1, target: 0, min_runs: 3 }),
    /out-of-enum metric/,
  );
});

test('build: min_runs が正の整数でなければ throw', () => {
  assert.throws(
    () => buildHypothesisBlock({ metric: 'micro_share', current: 0, target: 0.3, min_runs: 0 }),
    /min_runs/,
  );
  assert.throws(
    () => buildHypothesisBlock({ metric: 'micro_share', current: 0, target: 0.3, min_runs: 1.5 }),
    /min_runs/,
  );
});

test('parse: マーカー不在は null', () => {
  assert.equal(parseHypothesisBlock('hypothesis の無い issue body'), null);
  assert.equal(parseHypothesisBlock(null), null);
});

test('parse: end マーカー欠落は throw', () => {
  assert.throws(
    () => parseHypothesisBlock('<!-- dev-improve:hypothesis:begin -->\nmetric: micro_share'),
    /end マーカー/,
  );
});

test('parse: out-of-enum metric / status は throw', () => {
  const bad = [
    '<!-- dev-improve:hypothesis:begin -->',
    '```yaml', 'metric: bogus', 'current: 1', 'target: 0', 'min_runs: 3', 'status: pending', '```',
    '<!-- dev-improve:hypothesis:end -->',
  ].join('\n');
  assert.throws(() => parseHypothesisBlock(bad), /out-of-enum metric/);

  const badStatus = bad.replace('metric: bogus', 'metric: micro_share').replace('status: pending', 'status: maybe');
  assert.throws(() => parseHypothesisBlock(badStatus), /out-of-enum status/);
});

test('setHypothesisStatus: block 内の status のみ置換し他の本文は不変', () => {
  const block = buildHypothesisBlock({ metric: 'micro_share', current: 0.05, target: 0.2, min_runs: 4 });
  const body = `status: これは本文の status 行ではない\n\n${block}\n\nfooter`;
  const updated = setHypothesisStatus(body, 'confirmed');
  assert.equal(parseHypothesisBlock(updated).status, 'confirmed');
  assert.match(updated, /^status: これは本文の status 行ではない$/m);
  assert.equal(updated.split('\n').length, body.split('\n').length);
});

test('setHypothesisStatus: out-of-enum status / block 不在は throw', () => {
  const block = buildHypothesisBlock({ metric: 'micro_share', current: 0.05, target: 0.2, min_runs: 4 });
  assert.throws(() => setHypothesisStatus(block, 'bogus'), /out-of-enum status/);
  assert.throws(() => setHypothesisStatus('no block here', 'confirmed'), /存在しません/);
});
