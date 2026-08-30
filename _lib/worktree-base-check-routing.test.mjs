// worktree-base-check routing test（issue #517、issue #550 案1 で統合 call site へ書き換え）:
// dev-flow.js の Setup phase に配線された setup-base（resolve-base + worktree-base-check 統合）
// exec-proxy 呼び出しを source pin で検証する。
// setup-deps-routing.test.mjs Part 1（source pin）のパターンを踏襲する。
//
// このテストは:
//   (a) dev-flow.js に _lib/worktree-base-check.mjs（checkWorktreeBase 本体）の inline マーカーが
//       存在する
//   (b) label:'setup-base' の agent 呼び出しが存在し、agentType が dev-runner-haiku-ro（読み取り
//       専用）かつ retryOnContractViolation:true である
//   (c) label:'setup-base' の出現位置が label:'worktree'（Setup(worktree) agent）より前である
//   (d) resolveBase(BASE_ARG, setupProbe) と checkWorktreeBase({ issue: ISSUE, base: BASE, probe:
//       setupProbe }) の両呼び出しが同一 setupProbe を入力に使う
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

test('[worktree-base-check-routing] dev-flow.js に _lib/resolve-base.mjs の inline マーカーが存在する', () => {
  assert.ok(
    src.includes('// ==== BEGIN inline: _lib/resolve-base.mjs'),
    'dev-flow.js に "// ==== BEGIN inline: _lib/resolve-base.mjs" マーカーが存在しない',
  );
  assert.ok(
    src.includes('// ==== END inline: _lib/resolve-base.mjs ===='),
    'dev-flow.js に "// ==== END inline: _lib/resolve-base.mjs ====" マーカーが存在しない',
  );
});

test("[worktree-base-check-routing] dev-flow.js に label:'setup-base' の agent 呼び出しが存在する（agentType dev-runner-haiku-ro, retryOnContractViolation:true）", () => {
  assert.ok(
    src.includes("label: 'setup-base'"),
    'dev-flow.js に "label: \'setup-base\'" が存在しない',
  );
  const idx = src.indexOf("label: 'setup-base'");
  // 呼び出し全体（1000 文字程度手前まで遡って agentType を探す）を確認
  const windowStart = Math.max(0, idx - 1000);
  const window = src.slice(windowStart, idx + 200);
  assert.ok(
    window.includes("agentType: 'dev-runner-haiku-ro'"),
    "label:'setup-base' の周辺に agentType: 'dev-runner-haiku-ro' が見つからない",
  );
  assert.ok(
    window.includes('retryOnContractViolation: true'),
    "label:'setup-base' の周辺に retryOnContractViolation: true が見つからない",
  );
});

test("[worktree-base-check-routing] dev-flow.js に旧 label:'resolve-base' / label:'worktree-base-check' の agent 呼び出しが残存しない（統合による呼び出し数削減の静的証跡）", () => {
  assert.ok(
    !src.includes("label: 'resolve-base'"),
    'dev-flow.js に旧 label: \'resolve-base\' が残存している（setup-base への統合が未完了）',
  );
  assert.ok(
    !src.includes("label: 'worktree-base-check'"),
    'dev-flow.js に旧 label: \'worktree-base-check\' が残存している（setup-base への統合が未完了）',
  );
});

test("[worktree-base-check-routing] setup-base call は worktree call（Setup(worktree) agent）より前に配線されている", () => {
  const setupBaseIdx = src.indexOf("label: 'setup-base'");
  const worktreeIdx = src.indexOf("label: 'worktree'");

  assert.ok(setupBaseIdx !== -1, "label: 'setup-base' が見つからない");
  assert.ok(worktreeIdx !== -1, "label: 'worktree' が見つからない");

  assert.ok(
    setupBaseIdx < worktreeIdx,
    'setup-base call が worktree call（Setup(worktree) agent）より後に配線されている（fail-closed 検証が再利用前に発火しない）',
  );
});

test('[worktree-base-check-routing] dev-flow.js に resolveBase(BASE_ARG, setupProbe) の呼び出しが存在する', () => {
  assert.ok(
    src.includes('resolveBase(BASE_ARG, setupProbe)'),
    'dev-flow.js に "resolveBase(BASE_ARG, setupProbe)" の呼び出しが見つからない',
  );
});

test('[worktree-base-check-routing] dev-flow.js に checkWorktreeBase({ issue: ISSUE, base: BASE, probe: setupProbe }) の呼び出しが存在する（統合 probe を両関数へ渡す配線）', () => {
  assert.ok(
    src.includes('checkWorktreeBase({ issue: ISSUE, base: BASE, probe: setupProbe })'),
    'dev-flow.js に "checkWorktreeBase({ issue: ISSUE, base: BASE, probe: setupProbe })" の呼び出しが見つからない',
  );
});
