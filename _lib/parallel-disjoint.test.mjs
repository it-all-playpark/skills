import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDisjointParallel, diffDeclaredPaths } from './parallel-disjoint.mjs';

// (a) 衝突なし: parallel に A, B があり file_changes が重ならない → demoted 空・parallel 2件不変
test('衝突なし: parallel=[A:src/a.ts, B:src/b.ts] → demoted 空・parallel 2件不変', () => {
  const plan = {
    summary: 'test plan',
    serial: [],
    parallel: [
      { id: 'A', file_changes: ['src/a.ts'] },
      { id: 'B', file_changes: ['src/b.ts'] },
    ],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(demoted.length, 0);
  assert.equal(newPlan.parallel.length, 2);
  assert.equal(newPlan.parallel[0].id, 'A');
  assert.equal(newPlan.parallel[1].id, 'B');
  assert.equal(newPlan.serial.length, 0);
  // 元 plan を mutate していないこと
  assert.equal(plan.parallel.length, 2);
});

// (b) 衝突あり: A と B が src/shared.ts を共有 → B が demoted、parallel に A のみ、serial 末尾に B
test('衝突あり: A と B が src/shared.ts を共有 → B demote, parallel=[A], serial 末尾=[B]', () => {
  const plan = {
    summary: 'test plan',
    serial: [],
    parallel: [
      { id: 'A', file_changes: ['src/shared.ts'] },
      { id: 'B', file_changes: ['src/shared.ts', 'src/b.ts'] },
    ],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(newPlan.parallel.length, 1);
  assert.equal(newPlan.parallel[0].id, 'A');
  assert.equal(newPlan.serial.length, 1);
  assert.equal(newPlan.serial[0].id, 'B');
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].conflictsWith, 'A');
  assert.ok(demoted[0].paths.includes('src/shared.ts'), `paths should include 'src/shared.ts', got: ${JSON.stringify(demoted[0].paths)}`);
});

// (c) 'path: 説明'形式: file_changes に 'src/x.ts: 新規' → 説明部を無視して 'src/x.ts' が交差し B demote
test("'path: 説明'形式: A='src/x.ts: 新規', B='src/x.ts: 追記' → 説明部無視して交差・B demote", () => {
  const plan = {
    summary: 'test plan',
    serial: [],
    parallel: [
      { id: 'A', file_changes: ['src/x.ts: 新規'] },
      { id: 'B', file_changes: ['src/x.ts: 追記'] },
    ],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(newPlan.parallel.length, 1);
  assert.equal(newPlan.parallel[0].id, 'A');
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].conflictsWith, 'A');
  assert.ok(demoted[0].paths.includes('src/x.ts'), `paths should include 'src/x.ts', got: ${JSON.stringify(demoted[0].paths)}`);
});

// (d) パス表記ゆれ: './src/y.ts' と 'src/y.ts' と '  src/y.ts  ' が同一扱いで交差・B demote
test("パス表記ゆれ: './src/y.ts' と 'src/y.ts' が同一扱いで交差・B demote", () => {
  const plan = {
    summary: 'test plan',
    serial: [],
    parallel: [
      { id: 'A', file_changes: ['./src/y.ts'] },
      { id: 'B', file_changes: ['src/y.ts'] },
    ],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(newPlan.parallel.length, 1);
  assert.equal(newPlan.parallel[0].id, 'A');
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].conflictsWith, 'A');
});

test("パス表記ゆれ: 空白ゆれ '  src/y.ts  ' と 'src/y.ts' が同一扱いで交差・B demote", () => {
  const plan = {
    summary: 'test plan',
    serial: [],
    parallel: [
      { id: 'A', file_changes: ['  src/y.ts  '] },
      { id: 'B', file_changes: ['src/y.ts'] },
    ],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(newPlan.parallel.length, 1);
  assert.equal(newPlan.parallel[0].id, 'A');
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].conflictsWith, 'A');
});

// edge: parallel 未定義 → demoted 空・throw しない
test('edge: parallel 未定義 → demoted 空・throw しない', () => {
  const plan = {
    summary: 'no parallel',
    serial: [{ id: 'S1', file_changes: ['src/s.ts'] }],
  };
  let result;
  assert.doesNotThrow(() => {
    result = enforceDisjointParallel(plan);
  });
  assert.equal(result.demoted.length, 0);
});

// edge: parallel が空配列 → demoted 空・throw しない
test('edge: parallel が空配列 → demoted 空・parallel 空', () => {
  const plan = {
    summary: 'empty parallel',
    serial: [],
    parallel: [],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(demoted.length, 0);
  assert.equal(newPlan.parallel.length, 0);
});

// edge: file_changes 未定義の task → 空集合扱いで衝突しない
test('edge: file_changes 未定義の task → 空集合扱いで他 task と衝突しない', () => {
  const plan = {
    summary: 'test plan',
    serial: [],
    parallel: [
      { id: 'A' },
      { id: 'B', file_changes: ['src/b.ts'] },
    ],
  };
  const { plan: newPlan, demoted } = enforceDisjointParallel(plan);
  assert.equal(demoted.length, 0);
  assert.equal(newPlan.parallel.length, 2);
});

// 元 plan を mutate しないこと（serial 配列が元とは別）
test('元 plan を mutate しない: newPlan.serial は元 plan.serial とは別の配列', () => {
  const originalSerial = [{ id: 'S0', file_changes: ['src/s0.ts'] }];
  const plan = {
    summary: 'immutability test',
    serial: originalSerial,
    parallel: [
      { id: 'A', file_changes: ['src/shared.ts'] },
      { id: 'B', file_changes: ['src/shared.ts'] },
    ],
  };
  const { plan: newPlan } = enforceDisjointParallel(plan);
  // B が demote されて serial 末尾に追加されるが、元 plan.serial は変わらない
  assert.equal(plan.serial.length, 1, '元 plan.serial は変わらないこと');
  assert.equal(newPlan.serial.length, 2, 'newPlan.serial は S0 + B の 2 件');
  assert.notEqual(newPlan.serial, originalSerial, 'newPlan.serial は元配列とは別オブジェクト');
});

// ============================================================
// diffDeclaredPaths のテスト
// ============================================================

// (e) 宣言済みのみ: git status の全変更ファイルが plan の file_changes に含まれる → 空配列
test('diffDeclaredPaths: 宣言済みのみ → 空配列', () => {
  const planTasks = [
    { id: 'A', file_changes: ['src/a.ts', 'src/b.ts'] },
    { id: 'B', file_changes: ['src/c.ts: 新規作成'] },
  ];
  const changedFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  const result = diffDeclaredPaths(planTasks, changedFiles);
  assert.deepEqual(result, [], `宣言済みのみなら空配列。got: ${JSON.stringify(result)}`);
});

// (f) 宣言外1件: git status に plan に無いファイルが1件 → そのパスを含む配列
test('diffDeclaredPaths: 宣言外1件 → 検出', () => {
  const planTasks = [
    { id: 'A', file_changes: ['src/a.ts'] },
  ];
  const changedFiles = ['src/a.ts', 'src/undeclared.ts'];
  const result = diffDeclaredPaths(planTasks, changedFiles);
  assert.equal(result.length, 1);
  assert.ok(result.includes('src/undeclared.ts'), `expected 'src/undeclared.ts', got: ${JSON.stringify(result)}`);
});

// (g) 正規化が効く: 'path: 説明' 表記・'./' プレフィックス・空白ゆれが正規化されて宣言外と判定されない
test('diffDeclaredPaths: 正規化で宣言済みと一致 → 宣言外なし', () => {
  const planTasks = [
    { id: 'A', file_changes: ['./src/foo.ts: 新規作成', '  src/bar.ts  '] },
  ];
  // git status は通常 './'-なし形式で返すが normalizePath が両方を正規化するため一致
  const changedFiles = ['src/foo.ts', 'src/bar.ts'];
  const result = diffDeclaredPaths(planTasks, changedFiles);
  assert.deepEqual(result, [], `正規化で一致するはず。got: ${JSON.stringify(result)}`);
});

// (h) serial + parallel 両方の task を突合対象にする
test('diffDeclaredPaths: serial と parallel の両方の task を突合対象にする', () => {
  const planTasks = [
    { id: 'S1', file_changes: ['src/serial.ts'] },
    { id: 'P1', file_changes: ['src/parallel.ts'] },
  ];
  const changedFiles = ['src/serial.ts', 'src/parallel.ts', 'src/extra.ts'];
  const result = diffDeclaredPaths(planTasks, changedFiles);
  assert.equal(result.length, 1);
  assert.ok(result.includes('src/extra.ts'), `expected 'src/extra.ts', got: ${JSON.stringify(result)}`);
});

// (i) changedFiles 空 → 空配列
test('diffDeclaredPaths: changedFiles 空 → 空配列', () => {
  const planTasks = [
    { id: 'A', file_changes: ['src/a.ts'] },
  ];
  const result = diffDeclaredPaths(planTasks, []);
  assert.deepEqual(result, []);
});

// (j) planTasks 空 → 全 changedFiles が宣言外
test('diffDeclaredPaths: planTasks 空 → 全 changedFiles が宣言外', () => {
  const changedFiles = ['src/a.ts', 'src/b.ts'];
  const result = diffDeclaredPaths([], changedFiles);
  assert.equal(result.length, 2);
  assert.ok(result.includes('src/a.ts'));
  assert.ok(result.includes('src/b.ts'));
});

// (k) file_changes 未定義の task → 空集合扱い
test('diffDeclaredPaths: file_changes 未定義の task → 空集合扱い', () => {
  const planTasks = [{ id: 'A' }]; // file_changes なし
  const changedFiles = ['src/something.ts'];
  const result = diffDeclaredPaths(planTasks, changedFiles);
  assert.equal(result.length, 1);
  assert.ok(result.includes('src/something.ts'));
});
