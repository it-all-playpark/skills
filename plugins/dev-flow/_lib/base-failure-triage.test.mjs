import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  BASE_FAILING_LABEL, BASE_FAILING_ENV_KEY,
  normalizeTestPaths, testFileStem, isTestSubjectOf, planBaseRerun, classifyBaseRerun,
} from './base-failure-triage.mjs';

test('終端サマリー・ledger の表記と ENV key', () => {
  assert.equal(BASE_FAILING_LABEL, 'base でも失敗する既存の失敗');
  assert.equal(BASE_FAILING_ENV_KEY, 'base-failing');
});

test('normalizeTestPaths: 非文字列・空・重複を落とし先頭の ./ を外す（順序は保つ）', () => {
  assert.deepEqual(normalizeTestPaths(['./a/b.bats', 'a/b.bats', '', '  ', 3, null, 'c.test.mjs']), ['a/b.bats', 'c.test.mjs']);
  assert.deepEqual(normalizeTestPaths(undefined), []);
  assert.deepEqual(normalizeTestPaths('a.bats'), []);
});

test('testFileStem: テスト命名規約ごとの stem', () => {
  assert.equal(testFileStem('p/scripts/generate_thumbnail.bats'), 'generate_thumbnail');
  assert.equal(testFileStem('_lib/foo.test.mjs'), 'foo');
  assert.equal(testFileStem('src/Foo.spec.tsx'), 'Foo');
  assert.equal(testFileStem('pkg/foo_test.go'), 'foo');
  assert.equal(testFileStem('tests/test_foo.py'), 'foo');
  assert.equal(testFileStem('tests/other.sh'), 'other');
});

test('isTestSubjectOf: 同じディレクトリで stem が同じファイルだけがテスト対象のソース', () => {
  assert.equal(isTestSubjectOf('p/scripts/foo.bats', 'p/scripts/foo.sh'), true);
  assert.equal(isTestSubjectOf('_lib/foo.test.mjs', '_lib/foo.mjs'), true);
  assert.equal(isTestSubjectOf('p/scripts/foo.bats', 'p/other/foo.sh'), false, '別ディレクトリは対象外');
  assert.equal(isTestSubjectOf('p/scripts/foo.bats', 'p/scripts/foobar.sh'), false, 'stem の前方一致は対象外');
  assert.equal(isTestSubjectOf('p/scripts/foo.bats', 'p/scripts/foo.bats'), false, 'テストファイル自身は subject ではない（diff 一致は別判定）');
  assert.equal(isTestSubjectOf('foo.bats', 'foo.sh'), true, 'repo 直下');
});

test('planBaseRerun: diff が触ったテストファイル・テスト対象のソースが diff にあるファイルは touched（green-fix 対象）', () => {
  const r = planBaseRerun({
    failedFiles: ['a/x.bats', 'a/y.bats', 'b/z.test.mjs'],
    diffFiles: ['a/x.bats', 'a/y.sh', 'docs/readme.md'],
  });
  assert.deepEqual(r, { touched: ['a/x.bats', 'a/y.bats'], env: [], code: [], rerun: ['b/z.test.mjs'] });
});

test('planBaseRerun: 判定済み ENV は再実行せず env、base 再実行済みは code、diff に入った ENV は touched', () => {
  const r = planBaseRerun({
    failedFiles: ['e.bats', 'f.bats', 'g.bats', 'h.bats'],
    diffFiles: ['h.bats'],
    knownEnv: ['e.bats', 'h.bats'],
    knownBaseRan: ['f.bats'],
  });
  assert.deepEqual(r, { touched: ['h.bats'], env: ['e.bats'], code: ['f.bats'], rerun: ['g.bats'] });
});

test('classifyBaseRerun: ran・base_failed・same_failure がすべて true のものだけ ENV', () => {
  const r = classifyBaseRerun(['a.bats', 'b.bats', 'c.bats', 'd.bats', 'e.bats'], [
    { file: './a.bats', ran: true, base_failed: true, same_failure: true },
    { file: 'b.bats', ran: true, base_failed: false, same_failure: false },
    { file: 'c.bats', ran: true, base_failed: true, same_failure: false },
    { file: 'd.bats', ran: false, base_failed: true, same_failure: true },
  ]);
  assert.deepEqual(r, { env: ['a.bats'], code: ['b.bats', 'c.bats', 'd.bats', 'e.bats'], ran: ['a.bats', 'b.bats', 'c.bats'] });
});

test('classifyBaseRerun: 結果が無い・壊れているときは全件 code（green 要件を緩めない）', () => {
  assert.deepEqual(classifyBaseRerun(['a.bats'], null), { env: [], code: ['a.bats'], ran: [] });
  assert.deepEqual(classifyBaseRerun(['a.bats'], [null, 'x', { ran: true }]), { env: [], code: ['a.bats'], ran: [] });
  assert.deepEqual(classifyBaseRerun(['a.bats'], [{ file: 'a.bats', ran: 'true', base_failed: true, same_failure: true }]), { env: [], code: ['a.bats'], ran: [] });
});
