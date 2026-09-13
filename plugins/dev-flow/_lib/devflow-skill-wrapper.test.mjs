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

// (d) dev-flow-prerun と df- を含む（preflight 手順2 + 命名規約）
test('[devflow-skill-wrapper] dev-flow-prerun と df- 命名規約を含む', () => {
  assert.ok(
    src.includes('dev-flow-prerun'),
    'dev-flow/SKILL.md に `dev-flow-prerun` が含まれない（preflight 手順2）',
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

// (g) namespaced Workflow 名（plugin 由来 nested workflow は namespaced 名でしか解決しない）
test('[devflow-skill-wrapper] namespaced 名 dev-flow:dev-flow-run で起動する', () => {
  assert.ok(
    src.includes("name: 'dev-flow:dev-flow-run'"),
    'dev-flow/SKILL.md に namespaced 起動記述 `name: \'dev-flow:dev-flow-run\'` が見つからない',
  );
});

// (h) 自前の git worktree add 記述が残存していない（worktree 作成は dev-flow-prerun に吸収済み）
test('[devflow-skill-wrapper] git worktree add を含まない（prerun に吸収済み）', () => {
  assert.ok(
    !src.includes('git worktree add'),
    'dev-flow/SKILL.md に `git worktree add` が残存している（worktree 作成は dev-flow-prerun に一本化すること）',
  );
});

// (i) args.setup 転記と unwritable 退避分岐を明記する
test('[devflow-skill-wrapper] args.setup 転記と unwritable 退避分岐を明記する', () => {
  assert.ok(
    src.includes('setup:'),
    'dev-flow/SKILL.md に `args.setup` への転記記述（`setup:`）が見つからない',
  );
  assert.ok(
    src.includes('unwritable'),
    'dev-flow/SKILL.md に worktree_status:"unwritable" の退避分岐が見つからない',
  );
  assert.ok(
    src.includes('--worktree'),
    'dev-flow/SKILL.md に `--worktree` オプションの記述が見つからない',
  );
});

// (k) needs_clarification 再起動で前回 setup を使い回す記述が無い
//     isolation probe の token は setup.epoch 固定で run 内に前回 probe の cleanup が無い。
//     同じ setup で再起動すると Write-only agent が既存 probe ファイルへの上書きで written:false →
//     fail-closed abort する。再起動は dev-flow-prerun を再実行して新 epoch を得る経路のみ許す。
test('[devflow-skill-wrapper] needs_clarification 再起動で setup を再利用してよいと書かない', () => {
  const section = src.slice(src.indexOf('## needs_clarification'));
  assert.ok(section.length > 0, 'dev-flow/SKILL.md に `## needs_clarification` 節が無い');
  for (const banned of ['そのまま再利用してよく', '再実行は不要']) {
    assert.ok(
      !section.includes(banned),
      `dev-flow/SKILL.md needs_clarification 節に「${banned}」が残存している（前回 setup の使い回しは probe token 衝突で abort する。dev-flow-prerun を再実行して新 epoch を渡すこと）`,
    );
  }
  assert.ok(
    section.includes('dev-flow-prerun') && section.includes('epoch'),
    'dev-flow/SKILL.md needs_clarification 節に dev-flow-prerun 再実行（新 epoch）の指示が無い',
  );
});

// (j) args.base を渡す旧形式が残存していない（base は dev-flow-prerun が解決する）
test('[devflow-skill-wrapper] Workflow args に旧形式 base を渡さない', () => {
  assert.ok(
    !src.includes("base: '<base>'"),
    'dev-flow/SKILL.md に旧形式 `args: { issue: <N>, base: \'<base>\' }` が残存している（base は dev-flow-prerun が解決するので渡さない）',
  );
});
