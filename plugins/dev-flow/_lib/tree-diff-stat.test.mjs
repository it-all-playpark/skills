import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseTreeDiffStat, TREE_DIFF_STAT_MAX_FILES } from './tree-diff-stat.mjs';

test('TREE_DIFF_STAT_MAX_FILES === 50', () => {
  assert.equal(TREE_DIFF_STAT_MAX_FILES, 50);
});

test('追加のみの行を解析する', () => {
  const result = parseTreeDiffStat(['12\t0\tsrc/a.ts']);
  assert.deepEqual(result, {
    files: [{ path: 'src/a.ts', insertions: 12, deletions: 0 }],
    truncated: false,
  });
});

test('削除のみの行を解析する', () => {
  const result = parseTreeDiffStat(['0\t860\tdocs/x.md']);
  assert.deepEqual(result, {
    files: [{ path: 'docs/x.md', insertions: 0, deletions: 860 }],
    truncated: false,
  });
});

test('追加・削除両方の行を解析する', () => {
  const result = parseTreeDiffStat(['3\t5\tlib/y.mjs']);
  assert.deepEqual(result, {
    files: [{ path: 'lib/y.mjs', insertions: 3, deletions: 5 }],
    truncated: false,
  });
});

test('binary 行の "-" は 0 に変換する', () => {
  const result = parseTreeDiffStat(['-\t-\timg/logo.png']);
  assert.deepEqual(result, {
    files: [{ path: 'img/logo.png', insertions: 0, deletions: 0 }],
    truncated: false,
  });
});

test('数値として解釈できない値も 0 として扱う（throw しない）', () => {
  const result = parseTreeDiffStat(['abc\txyz\tsrc/weird.ts']);
  assert.deepEqual(result, {
    files: [{ path: 'src/weird.ts', insertions: 0, deletions: 0 }],
    truncated: false,
  });
});

test('51 行入力は先頭 50 件だけを保持し truncated: true', () => {
  const lines = Array.from({ length: 51 }, (_, i) => `${i}\t0\tfile-${i}.ts`);
  const result = parseTreeDiffStat(lines);
  assert.equal(result.files.length, 50);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.files[49], { path: 'file-49.ts', insertions: 49, deletions: 0 });
});

test('ちょうど 50 行入力は 50 件を保持し truncated: false', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `${i}\t0\tfile-${i}.ts`);
  const result = parseTreeDiffStat(lines);
  assert.equal(result.files.length, 50);
  assert.equal(result.truncated, false);
});

test('空配列は {files:[], truncated:false}', () => {
  assert.deepEqual(parseTreeDiffStat([]), { files: [], truncated: false });
});

test('null は {files:[], truncated:false}', () => {
  assert.deepEqual(parseTreeDiffStat(null), { files: [], truncated: false });
});

test('undefined は {files:[], truncated:false}', () => {
  assert.deepEqual(parseTreeDiffStat(undefined), { files: [], truncated: false });
});

test('非配列（文字列）は {files:[], truncated:false}', () => {
  assert.deepEqual(parseTreeDiffStat('12\t0\tsrc/a.ts'), { files: [], truncated: false });
});

test('空行・タブ不足行は skip され有効行のみ数える', () => {
  const result = parseTreeDiffStat([
    '',
    '   ',
    '12\t0\tsrc/a.ts',
    'no-tabs-here',
    '3\tonly-one-tab',
    '5\t2\tlib/b.mjs',
  ]);
  assert.deepEqual(result, {
    files: [
      { path: 'src/a.ts', insertions: 12, deletions: 0 },
      { path: 'lib/b.mjs', insertions: 5, deletions: 2 },
    ],
    truncated: false,
  });
});

test('path が空の行は skip される', () => {
  const result = parseTreeDiffStat(['3\t5\t', '3\t5\tlib/y.mjs']);
  assert.deepEqual(result, {
    files: [{ path: 'lib/y.mjs', insertions: 3, deletions: 5 }],
    truncated: false,
  });
});

test('rename 表記（" => " を含む path）を verbatim 保持する', () => {
  const result = parseTreeDiffStat(['4\t2\tsrc/{old.ts => new.ts}']);
  assert.deepEqual(result, {
    files: [{ path: 'src/{old.ts => new.ts}', insertions: 4, deletions: 2 }],
    truncated: false,
  });
});

test('path 内に追加のタブを含む場合も verbatim 保持する', () => {
  const result = parseTreeDiffStat(['4\t2\tsrc/a.ts\tsrc/b.ts']);
  assert.deepEqual(result, {
    files: [{ path: 'src/a.ts\tsrc/b.ts', insertions: 4, deletions: 2 }],
    truncated: false,
  });
});

test('末尾 CR 付き行は CR を path 末尾から除去する', () => {
  const result = parseTreeDiffStat(['4\t2\tsrc/a.ts\r']);
  assert.deepEqual(result, {
    files: [{ path: 'src/a.ts', insertions: 4, deletions: 2 }],
    truncated: false,
  });
});

test('入力配列を mutate しない', () => {
  const lines = ['12\t0\tsrc/a.ts', '3\t5\tlib/y.mjs'];
  const snapshot = [...lines];
  parseTreeDiffStat(lines);
  assert.deepEqual(lines, snapshot);
});
