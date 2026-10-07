import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  LOCAL_VERIFY_WAIT_SEC, LOCAL_VERIFY_TAIL_MAX,
  localVerifyWaitPolls, localVerifyVerdict, localVerifyFeedback, localVerifyCiOutcome,
} from './local-verify.mjs';

test('[local-verify] localVerifyVerdict: passed は exit_code 0 が揃ったときだけ。timeout は failed、応答なし・未知の status は error', () => {
  assert.equal(localVerifyVerdict({ status: 'passed', exit_code: 0 }), 'passed');
  assert.equal(localVerifyVerdict({ status: 'passed', exit_code: 1 }), 'error');
  assert.equal(localVerifyVerdict({ status: 'passed' }), 'error');
  assert.equal(localVerifyVerdict({ status: 'failed', exit_code: 1 }), 'failed');
  assert.equal(localVerifyVerdict({ status: 'timeout', exit_code: 143 }), 'failed');
  assert.equal(localVerifyVerdict({ status: 'unavailable', reason: 'x' }), 'unavailable');
  assert.equal(localVerifyVerdict({ status: 'running' }), 'running');
  for (const res of [null, undefined, 'passed', { status: 'stopped' }, { status: 'error' }]) assert.equal(localVerifyVerdict(res), 'error', JSON.stringify(res));
});

test('[local-verify] localVerifyWaitPolls: timeout_seconds を 1 回の待機秒数で割った回数 + 1', () => {
  assert.equal(localVerifyWaitPolls(1500), Math.ceil(1500 / LOCAL_VERIFY_WAIT_SEC) + 1);
  assert.equal(localVerifyWaitPolls(LOCAL_VERIFY_WAIT_SEC), 2);
  assert.equal(localVerifyWaitPolls(null), 1);
});

test('[local-verify] localVerifyFeedback: ci の AC ごとに log_path と log の末尾（上限で切る）を添える', () => {
  const tail = 'x'.repeat(LOCAL_VERIFY_TAIL_MAX) + 'END';
  const fb = localVerifyFeedback({
    result: { status: 'failed', exit_code: 1, log_path: '/wt/log', log_tail: tail },
    command: 'pnpm test:e2e:local', acIndexes: [1], acceptanceCriteria: ['a', 'e2e が通る'],
  });
  assert.equal(fb.length, 1);
  assert.equal(fb[0].topic, 'AC-2 未達');
  assert.equal(fb[0].ac_index, 1);
  assert.match(fb[0].description, /AC-2「e2e が通る」のローカル実行（`pnpm test:e2e:local`.*）が exit 1 で失敗した/);
  assert.equal(fb[0].log_path, '/wt/log');
  assert.equal(fb[0].log_tail.length, LOCAL_VERIFY_TAIL_MAX);
  assert.ok(fb[0].log_tail.endsWith('END'));
  const timeout = localVerifyFeedback({ result: { status: 'timeout', exit_code: 143 }, command: 'c', acIndexes: [0], acceptanceCriteria: ['a'] });
  assert.match(timeout[0].description, /timeout_seconds を超えて止められた/);
});

test('[local-verify] localVerifyCiOutcome: passed / failed で決着した run だけ source:local の判定を作る', () => {
  const lv = { status: 'passed', command: 'pnpm test:e2e:local', exit_code: 0, log_path: '/wt/log', reimpl_count: 0 };
  assert.deepEqual(localVerifyCiOutcome(lv), { source: 'local', status: 'passed', command: 'pnpm test:e2e:local', exit_code: 0, log_path: '/wt/log' });
  assert.equal(localVerifyCiOutcome({ ...lv, status: 'failed', exit_code: 2 }).status, 'failed');
  for (const status of ['unavailable', 'error', 'skipped']) assert.equal(localVerifyCiOutcome({ status, reason: 'x' }), null, status);
  assert.equal(localVerifyCiOutcome(null), null);
});
