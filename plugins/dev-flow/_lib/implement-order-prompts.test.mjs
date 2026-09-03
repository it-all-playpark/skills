// 静的 pin テスト（issue #534, F2）: dev-planner.md / plan-reviewer.md に
// 「parallel 群を先に同時実行し、その後 serial 列を実行する」実行順序と
// 依存方向の妥当性検証項目が明記されていることを pin する。
//
// runImplement（.claude/workflows/dev-flow.js）は plan.parallel を先に fan-out し、
// その後 plan.serial を配列順に実行する（parallel→serial）。したがって serial task は
// parallel task の成果物に依存してよいが、逆方向（parallel が serial の成果物に依存）は
// 実行時点で未生成の成果を参照して BLOCKED になる。この不変条件を agent プロンプトが
// 正しく伝えているかを source string で pin する。
//
// パターン: _lib/devflow-phase-functions.test.mjs と同スタイル（readFileSync + regex +
// node:assert/strict、VM sandbox は使わない source-string only）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/agents');
const devPlannerPath = join(agentsDir, 'dev-planner.md');
const planReviewerPath = join(agentsDir, 'plan-reviewer.md');

const devPlannerSrc = readFileSync(devPlannerPath, 'utf8');
const planReviewerSrc = readFileSync(planReviewerPath, 'utf8');

test('[AC-a] dev-planner.md が parallel 群の先行同時実行を明記している', () => {
  assert.ok(
    devPlannerSrc.includes('parallel 群を先に同時実行'),
    'dev-planner.md に "parallel 群を先に同時実行" が含まれていない',
  );
});

test('[AC-b] dev-planner.md が parallel→serial 方向の依存を禁止する規則を明記している', () => {
  assert.ok(
    devPlannerSrc.includes('parallel task が serial task の成果物に依存する計画は立てるな'),
    'dev-planner.md に "parallel task が serial task の成果物に依存する計画は立てるな" が含まれていない',
  );
});

test('[AC-c] plan-reviewer.md が実行順（parallel → serial）を明記している', () => {
  assert.ok(
    planReviewerSrc.includes('parallel → serial'),
    'plan-reviewer.md に "parallel → serial" が含まれていない',
  );
});

test('[AC-d] plan-reviewer.md が parallel→serial 依存方向の検証項目を明記している', () => {
  assert.ok(
    planReviewerSrc.includes('serial[] の task の成果物に依存していないか'),
    'plan-reviewer.md に "serial[] の task の成果物に依存していないか" が含まれていない',
  );
});

test('[AC-e] plan-reviewer.md の implementation_order dimension 行に (c)(d) の literal が両方含まれる', () => {
  const line = planReviewerSrc
    .split('\n')
    .find((l) => l.includes('implementation_order'));

  assert.ok(line, 'implementation_order を含む行が見つからない');
  assert.ok(
    line.includes('parallel → serial'),
    'implementation_order 行に "parallel → serial" が含まれていない',
  );
  assert.ok(
    line.includes('serial[] の task の成果物に依存していないか'),
    'implementation_order 行に "serial[] の task の成果物に依存していないか" が含まれていない',
  );
});
