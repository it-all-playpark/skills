import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecksGreen, BUILD_CHECK_RE, CI_VERIFIABLE_ENV_KEYS, CHECKS } from './ci-checks.mjs';

test('buildChecksGreen: Vercel+build 全 pass → green:true・checkNames に両名', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'pass' },
    { name: 'lint', bucket: 'pass' },
  ];
  const result = buildChecksGreen(checks);
  assert.deepEqual(result, {
    green: true,
    reason: 'all-pass',
    checkNames: ['Vercel – Deployment', 'Build and Test'],
  });
});

test('buildChecksGreen: build 系 1 件 pending → green:false/reason:pending', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'pending' },
  ];
  const result = buildChecksGreen(checks);
  assert.equal(result.green, false);
  assert.equal(result.reason, 'pending');
  assert.deepEqual(result.checkNames, ['Vercel – Deployment', 'Build and Test']);
});

test('buildChecksGreen: build 系 1 件 fail → green:false/reason:not-pass', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'fail' },
  ];
  const result = buildChecksGreen(checks);
  assert.equal(result.green, false);
  assert.equal(result.reason, 'not-pass');
  assert.deepEqual(result.checkNames, ['Vercel – Deployment', 'Build and Test']);
});

test('buildChecksGreen: lint/test のみで build 系不在 → green:false/reason:no-build-checks', () => {
  const checks = [
    { name: 'lint', bucket: 'pass' },
    { name: 'test', bucket: 'pass' },
  ];
  const result = buildChecksGreen(checks);
  assert.deepEqual(result, { green: false, reason: 'no-build-checks', checkNames: [] });
});

test('buildChecksGreen: 空配列 → no-build-checks', () => {
  const result = buildChecksGreen([]);
  assert.deepEqual(result, { green: false, reason: 'no-build-checks', checkNames: [] });
});

test('buildChecksGreen: 非配列（null）→ invalid', () => {
  assert.deepEqual(buildChecksGreen(null), { green: false, reason: 'invalid', checkNames: [] });
});

test('buildChecksGreen: 非配列（undefined）→ invalid', () => {
  assert.deepEqual(buildChecksGreen(undefined), { green: false, reason: 'invalid', checkNames: [] });
});

test('buildChecksGreen: 非配列（object）→ invalid', () => {
  assert.deepEqual(buildChecksGreen({ name: 'build', bucket: 'pass' }), {
    green: false,
    reason: 'invalid',
    checkNames: [],
  });
});

test('buildChecksGreen: bucket:skipping の build check → green:false（pass 以外は解消しない）', () => {
  const checks = [{ name: 'Build and Test', bucket: 'skipping' }];
  const result = buildChecksGreen(checks);
  assert.equal(result.green, false);
  assert.equal(result.reason, 'not-pass');
  assert.deepEqual(result.checkNames, ['Build and Test']);
});

test('buildChecksGreen: name 大文字小文字混在マッチ（Vercel – Deployment / CI / Build and Test）、lint は不一致', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'CI', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'pass' },
    { name: 'lint', bucket: 'pass' },
  ];
  const result = buildChecksGreen(checks);
  assert.equal(result.green, true);
  assert.deepEqual(result.checkNames, ['Vercel – Deployment', 'CI', 'Build and Test']);
  assert.equal(BUILD_CHECK_RE.test('lint'), false);
  assert.equal(BUILD_CHECK_RE.test('Vercel – Deployment'), true);
  assert.equal(BUILD_CHECK_RE.test('CI'), true);
  assert.equal(BUILD_CHECK_RE.test('Build and Test'), true);
});

test('buildChecksGreen: name が string でない要素は除外される', () => {
  const checks = [
    { name: 'Build and Test', bucket: 'pass' },
    { name: null, bucket: 'pass' },
    { name: 123, bucket: 'pass' },
  ];
  const result = buildChecksGreen(checks);
  assert.equal(result.green, true);
  assert.deepEqual(result.checkNames, ['Build and Test']);
});

test('CI_VERIFIABLE_ENV_KEYS: turbopack-sandbox のみ（npm-cache-eperm 不含 — AC-3 allowlist 固定）', () => {
  assert.deepEqual(CI_VERIFIABLE_ENV_KEYS, ['turbopack-sandbox']);
});

test('CHECKS schema: required が [ok]', () => {
  assert.deepEqual(CHECKS.required, ['ok']);
  assert.equal(CHECKS.type, 'object');
});
