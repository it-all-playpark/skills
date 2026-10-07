// final-test-rerun.test.mjs — test#final の単体再実行の対象選択と flake 判定（issue #865）。
// workflow への配線（再実行の起動・merge tier・サマリー）は final-reconcile-routing.test.mjs の (n)〜(p) が見る。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { finalTestRerunFiles, finalTestRerunVerdict } from './final-test-rerun.mjs';

const red = (failed_files) => ({ tests: 'failed', green: false, summary: '', failed_files });

test('finalTestRerunFiles: tests:failed の failed_files を ./ を外して重複なく返す', () => {
  assert.deepEqual(finalTestRerunFiles(red(['./plugins/a.bats', 'plugins/a.bats', 'tests/b.test.mjs', '.github/c.bats'])),
    ['plugins/a.bats', 'tests/b.test.mjs', '.github/c.bats']);
});

test('finalTestRerunFiles: failed 以外・failed_files 空 / 欠落は再実行しない', () => {
  assert.deepEqual(finalTestRerunFiles(null), []);
  assert.deepEqual(finalTestRerunFiles({ tests: 'passed', green: true, failed_files: ['a.bats'] }), []);
  assert.deepEqual(finalTestRerunFiles({ tests: 'error', green: false, failed_files: ['a.bats'] }), []);
  assert.deepEqual(finalTestRerunFiles(red([])), []);
  assert.deepEqual(finalTestRerunFiles({ tests: 'failed', green: false }), []);
});

test('finalTestRerunFiles: argv に安全に並べられないパスが 1 件でもあれば全体を再実行しない', () => {
  for (const bad of ['/abs/a.bats', '../a.bats', 'x/../a.bats', '-a.bats', 'a b.bats', 'a;rm.bats', '$(x).bats', 'a//b.bats', '', 42]) {
    assert.deepEqual(finalTestRerunFiles(red(['ok.bats', bad])), [], `bad=${JSON.stringify(bad)}`);
  }
});

test('finalTestRerunVerdict: 再実行が passed + green のときだけ flake、1 回目のログを summary から重複なく拾う', () => {
  const first = {
    summary: 'failed: /wt/tests/run-a.sh (exit 1, log: /tmp/r/0.log)\nfailed: /wt/tests/run-b.sh (exit 2, log: /tmp/r/1.log)\nfailed: x (exit 1, log: /tmp/r/0.log)',
  };
  assert.deepEqual(finalTestRerunVerdict(first, { tests: 'passed', green: true }, ['a.bats']),
    { files: ['a.bats'], logs: ['/tmp/r/0.log', '/tmp/r/1.log'] });
  assert.deepEqual(finalTestRerunVerdict({ summary: 'boom' }, { tests: 'passed', green: true }, ['a.bats']), { files: ['a.bats'], logs: [] });
  for (const rerun of [null, { tests: 'failed', green: false }, { tests: 'error', green: false }, { tests: 'no_tests', green: false }, { tests: 'passed', green: false }]) {
    assert.equal(finalTestRerunVerdict(first, rerun, ['a.bats']), null, JSON.stringify(rerun));
  }
});
