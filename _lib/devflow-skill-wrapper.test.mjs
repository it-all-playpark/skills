// Regression test: dev-flow/SKILL.md（起動 wrapper skill）が isolation preflight 手順を
// 呼び出し元セッションへ届けることを保証する。
//
// 背景: bg 起動セッションが isolation preflight を踏まずに Workflow('dev-flow-run') を直接叩くと、
// Setup 直後の isolation probe が written:false で fail-closed abort する（AGENTS.md /
// .claude/rules/dev-flow.md 参照）。dev-flow/SKILL.md は (1) base 解決、(2) worktree 作成/再利用、
// (3) EnterWorktree、(4) Workflow('dev-flow-run') 起動の 4 手順を明記し、直列複数 issue 実行時の
// worktree 切替も記述する必要がある。
//
// このテストは SKILL.md の存在と必須内容を source-string で assert する（決定論的 pin）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const skillPath = join(repoRoot, 'dev-flow/SKILL.md');

// (a) dev-flow/SKILL.md が存在する
test('[devflow-skill-wrapper] dev-flow/SKILL.md が存在する', () => {
  assert.ok(existsSync(skillPath), 'dev-flow/SKILL.md が存在しない');
});

const src = readFileSync(skillPath, 'utf8');

// (b) dev-flow-run を含む（Workflow 起動が新名称）
test('[devflow-skill-wrapper] dev-flow-run（Workflow の新名称）を含む', () => {
  assert.ok(
    src.includes('dev-flow-run'),
    'dev-flow/SKILL.md に dev-flow-run が含まれない（Workflow 起動は新名称を使うこと）',
  );
});

// (c) EnterWorktree を含む
test('[devflow-skill-wrapper] EnterWorktree を含む', () => {
  assert.ok(
    src.includes('EnterWorktree'),
    'dev-flow/SKILL.md に EnterWorktree が含まれない（preflight 手順3）',
  );
});

// (d) git worktree add と df- を含む（preflight 手順2 + 命名規約）
test('[devflow-skill-wrapper] git worktree add と df- 命名規約を含む', () => {
  assert.ok(
    src.includes('git worktree add'),
    'dev-flow/SKILL.md に `git worktree add` が含まれない（preflight 手順2）',
  );
  assert.ok(
    src.includes('df-'),
    'dev-flow/SKILL.md に `df-` worktree 命名規約が含まれない',
  );
});

// (e) worktree 切替の明記（EnterWorktree が2回以上出現、または「切り替え」を含む）
test('[devflow-skill-wrapper] 直列複数 issue 実行時の worktree 切替を明記する', () => {
  const enterWorktreeCount = (src.match(/EnterWorktree/g) || []).length;
  assert.ok(
    enterWorktreeCount >= 2 || src.includes('切り替え'),
    'dev-flow/SKILL.md に直列複数 issue 実行時の worktree 切替（EnterWorktree 複数回言及 or「切り替え」）が明記されていない',
  );
});

// (f) 旧名での起動記述（Workflow({ name: 'dev-flow', ）を含まない
test('[devflow-skill-wrapper] 旧名 Workflow({ name: \'dev-flow\', を含まない', () => {
  assert.ok(
    !src.includes(`Workflow({ name: 'dev-flow',`),
    'dev-flow/SKILL.md に旧名での起動記述 `Workflow({ name: \'dev-flow\',` が残存している（dev-flow-run を使うこと）',
  );
});
