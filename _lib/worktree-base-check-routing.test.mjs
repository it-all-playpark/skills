// worktree-base-check routing test（issue #517）: dev-flow.js の Setup phase に配線された
// worktree-base-check exec-proxy 呼び出しを source pin で検証する。
// setup-deps-routing.test.mjs Part 1（source pin）のパターンを踏襲する。
//
// このテストは:
//   (a) dev-flow.js に _lib/worktree-base-check.mjs の inline マーカーが存在する
//   (b) label:'worktree-base-check' の agent 呼び出しが存在し、agentType が
//       dev-runner-haiku-ro（読み取り専用）である
//   (c) label:'worktree-base-check' の出現位置が label:'resolve-base' より後、
//       かつ label:'worktree'（Setup(worktree) agent）より前である
//   (d) checkWorktreeBase({ issue: ISSUE, base: BASE の呼び出しが存在する
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// Part 1: source pin
// ============================================================

test('[worktree-base-check-routing] dev-flow.js に _lib/worktree-base-check.mjs の inline マーカーが存在する', () => {
  assert.ok(
    src.includes('// ==== BEGIN inline: _lib/worktree-base-check.mjs'),
    'dev-flow.js に "// ==== BEGIN inline: _lib/worktree-base-check.mjs" マーカーが存在しない',
  );
  assert.ok(
    src.includes('// ==== END inline: _lib/worktree-base-check.mjs ===='),
    'dev-flow.js に "// ==== END inline: _lib/worktree-base-check.mjs ====" マーカーが存在しない',
  );
});

test('[worktree-base-check-routing] dev-flow.js に label:\'worktree-base-check\' の agent 呼び出しが存在する（agentType dev-runner-haiku-ro）', () => {
  assert.ok(
    src.includes("label: 'worktree-base-check'"),
    'dev-flow.js に "label: \'worktree-base-check\'" が存在しない',
  );
  const idx = src.indexOf("label: 'worktree-base-check'");
  // 呼び出し全体（1000 文字程度手前まで遡って agentType を探す）を確認
  const windowStart = Math.max(0, idx - 1000);
  const window = src.slice(windowStart, idx + 200);
  assert.ok(
    window.includes("agentType: 'dev-runner-haiku-ro'"),
    'label:\'worktree-base-check\' の周辺に agentType: \'dev-runner-haiku-ro\' が見つからない',
  );
});

test('[worktree-base-check-routing] worktree-base-check call は resolve-base call の後・worktree call の前に配線されている', () => {
  const resolveBaseIdx = src.indexOf("label: 'resolve-base'");
  const worktreeBaseCheckIdx = src.indexOf("label: 'worktree-base-check'");
  const worktreeIdx = src.indexOf("label: 'worktree'");

  assert.ok(resolveBaseIdx !== -1, "label: 'resolve-base' が見つからない");
  assert.ok(worktreeBaseCheckIdx !== -1, "label: 'worktree-base-check' が見つからない");
  assert.ok(worktreeIdx !== -1, "label: 'worktree' が見つからない");

  assert.ok(
    resolveBaseIdx < worktreeBaseCheckIdx,
    'worktree-base-check call が resolve-base call より前に配線されている（順序不正）',
  );
  assert.ok(
    worktreeBaseCheckIdx < worktreeIdx,
    'worktree-base-check call が worktree call（Setup(worktree) agent）より後に配線されている（fail-closed 検証が再利用前に発火しない）',
  );
});

test('[worktree-base-check-routing] dev-flow.js に checkWorktreeBase({ issue: ISSUE, base: BASE の呼び出しが存在する', () => {
  assert.ok(
    src.includes('checkWorktreeBase({ issue: ISSUE, base: BASE'),
    'dev-flow.js に "checkWorktreeBase({ issue: ISSUE, base: BASE" の呼び出しが見つからない',
  );
});
