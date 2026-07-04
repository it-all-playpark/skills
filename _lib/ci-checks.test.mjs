import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envChecksGreen, ENV_CHECK_RES, CI_VERIFIABLE_ENV_KEYS, CHECKS } from './ci-checks.mjs';

// --- turbopack-sandbox 回帰（旧 buildChecksGreen テストの移植） ---

test('envChecksGreen(turbopack-sandbox): Vercel+build 全 pass → green:true・checkNames に両名', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'pass' },
    { name: 'lint', bucket: 'pass' },
  ];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.deepEqual(result, {
    green: true,
    reason: 'all-pass',
    checkNames: ['Vercel – Deployment', 'Build and Test'],
  });
});

test('envChecksGreen(turbopack-sandbox): build 系 1 件 pending → green:false/reason:pending', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'pending' },
  ];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.equal(result.green, false);
  assert.equal(result.reason, 'pending');
  assert.deepEqual(result.checkNames, ['Vercel – Deployment', 'Build and Test']);
});

test('envChecksGreen(turbopack-sandbox): build 系 1 件 fail → green:false/reason:not-pass', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'fail' },
  ];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.equal(result.green, false);
  assert.equal(result.reason, 'not-pass');
  assert.deepEqual(result.checkNames, ['Vercel – Deployment', 'Build and Test']);
});

test('envChecksGreen(turbopack-sandbox): lint/test のみで build 系不在 → green:false/reason:no-matching-checks', () => {
  const checks = [
    { name: 'lint', bucket: 'pass' },
    { name: 'test', bucket: 'pass' },
  ];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.deepEqual(result, { green: false, reason: 'no-matching-checks', checkNames: [] });
});

test('envChecksGreen(turbopack-sandbox): 空配列 → no-matching-checks', () => {
  const result = envChecksGreen([], 'turbopack-sandbox');
  assert.deepEqual(result, { green: false, reason: 'no-matching-checks', checkNames: [] });
});

test('envChecksGreen(turbopack-sandbox): 非配列（null）→ invalid', () => {
  assert.deepEqual(envChecksGreen(null, 'turbopack-sandbox'), { green: false, reason: 'invalid', checkNames: [] });
});

test('envChecksGreen(turbopack-sandbox): 非配列（undefined）→ invalid', () => {
  assert.deepEqual(envChecksGreen(undefined, 'turbopack-sandbox'), { green: false, reason: 'invalid', checkNames: [] });
});

test('envChecksGreen(turbopack-sandbox): 非配列（object）→ invalid', () => {
  assert.deepEqual(envChecksGreen({ name: 'build', bucket: 'pass' }, 'turbopack-sandbox'), {
    green: false,
    reason: 'invalid',
    checkNames: [],
  });
});

test('envChecksGreen(turbopack-sandbox): bucket:skipping の build check → green:false（pass 以外は解消しない）', () => {
  const checks = [{ name: 'Build and Test', bucket: 'skipping' }];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.equal(result.green, false);
  assert.equal(result.reason, 'not-pass');
  assert.deepEqual(result.checkNames, ['Build and Test']);
});

test('envChecksGreen(turbopack-sandbox): name 大文字小文字混在マッチ（Vercel – Deployment / CI / Build and Test）、lint は不一致', () => {
  const checks = [
    { name: 'Vercel – Deployment', bucket: 'pass' },
    { name: 'CI', bucket: 'pass' },
    { name: 'Build and Test', bucket: 'pass' },
    { name: 'lint', bucket: 'pass' },
  ];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.equal(result.green, true);
  assert.deepEqual(result.checkNames, ['Vercel – Deployment', 'CI', 'Build and Test']);
  assert.equal(ENV_CHECK_RES['turbopack-sandbox'].test('lint'), false);
  assert.equal(ENV_CHECK_RES['turbopack-sandbox'].test('Vercel – Deployment'), true);
  assert.equal(ENV_CHECK_RES['turbopack-sandbox'].test('CI'), true);
  assert.equal(ENV_CHECK_RES['turbopack-sandbox'].test('Build and Test'), true);
});

test('envChecksGreen(turbopack-sandbox): name が string でない要素は除外される', () => {
  const checks = [
    { name: 'Build and Test', bucket: 'pass' },
    { name: null, bucket: 'pass' },
    { name: 123, bucket: 'pass' },
  ];
  const result = envChecksGreen(checks, 'turbopack-sandbox');
  assert.equal(result.green, true);
  assert.deepEqual(result.checkNames, ['Build and Test']);
});

// --- bats-sandbox ---

test('envChecksGreen(bats-sandbox): bats/test 系 check 全 pass（Lint は不一致で除外、fail でも影響なし）→ green:true', () => {
  const checks = [
    { name: 'Bats Tests (issue #93 helpers)', bucket: 'pass' },
    { name: 'Node Unit Tests (workflow arg resolver)', bucket: 'pass' },
    { name: 'Subagent Dispatch Rules Lint', bucket: 'fail' },
  ];
  const result = envChecksGreen(checks, 'bats-sandbox');
  assert.equal(result.green, true);
  assert.equal(result.reason, 'all-pass');
  assert.deepEqual(result.checkNames, ['Bats Tests (issue #93 helpers)', 'Node Unit Tests (workflow arg resolver)']);
});

test('envChecksGreen(bats-sandbox): bats check が pending → reason:pending', () => {
  const checks = [
    { name: 'Bats Tests (issue #93 helpers)', bucket: 'pending' },
    { name: 'Node Unit Tests (workflow arg resolver)', bucket: 'pass' },
  ];
  const result = envChecksGreen(checks, 'bats-sandbox');
  assert.equal(result.green, false);
  assert.equal(result.reason, 'pending');
});

test('envChecksGreen(bats-sandbox): Subagent Dispatch Rules Lint のみ → no-matching-checks', () => {
  const checks = [{ name: 'Subagent Dispatch Rules Lint', bucket: 'pass' }];
  const result = envChecksGreen(checks, 'bats-sandbox');
  assert.deepEqual(result, { green: false, reason: 'no-matching-checks', checkNames: [] });
});

// --- regex 境界（本 issue の動機となった不一致の固定） ---

test('regex 境界: bats-sandbox は Bats Tests にマッチ、turbopack-sandbox は不一致', () => {
  assert.equal(ENV_CHECK_RES['bats-sandbox'].test('Bats Tests (issue #93 helpers)'), true);
  assert.equal(ENV_CHECK_RES['turbopack-sandbox'].test('Bats Tests (issue #93 helpers)'), false);
});

// --- unknown env key ---

test('envChecksGreen: allowlist 外の env key → unknown-env-key（fail-open）', () => {
  const result = envChecksGreen([{ name: 'build', bucket: 'pass' }], 'npm-cache-eperm');
  assert.deepEqual(result, { green: false, reason: 'unknown-env-key', checkNames: [] });
});

// --- CI_VERIFIABLE_ENV_KEYS allowlist 固定 ---

test('CI_VERIFIABLE_ENV_KEYS: turbopack-sandbox, bats-sandbox のみ（npm-cache-eperm 不含 — allowlist 固定）', () => {
  assert.deepEqual(CI_VERIFIABLE_ENV_KEYS, ['turbopack-sandbox', 'bats-sandbox']);
});

// --- CHECKS schema ---

test('CHECKS schema: required が [ok]', () => {
  assert.deepEqual(CHECKS.required, ['ok']);
  assert.equal(CHECKS.type, 'object');
});
