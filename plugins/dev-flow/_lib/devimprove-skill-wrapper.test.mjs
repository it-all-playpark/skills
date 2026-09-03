// Regression test: dev-flow-improve/SKILL.md（起動 wrapper skill）が dev-improve workflow を
// namespaced 名で起動することを保証する。
//
// 背景: plugin 由来の dynamic workflow は namespaced 名（`<plugin>:<workflow>`）でしか解決しない。
// bare `dev-improve` のままだと plugin install 環境で /dev-flow-improve が起動不能になる
// （dev-flow/SKILL.md 側は devflow-skill-wrapper.test.mjs が同じ invariant を pin する）。
//
// このテストは SKILL.md の存在と必須内容を source-string で assert する（決定論的 pin）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const skillPath = join(repoRoot, 'dev-flow-improve/SKILL.md');

// (a) dev-flow-improve/SKILL.md が存在する
test('[devimprove-skill-wrapper] dev-flow-improve/SKILL.md が存在する', () => {
  assert.ok(existsSync(skillPath), 'dev-flow-improve/SKILL.md が存在しない');
});

const src = readFileSync(skillPath, 'utf8');

// (b) namespaced 名で起動する
test('[devimprove-skill-wrapper] namespaced 名 dev-flow:dev-improve で起動する', () => {
  assert.ok(
    src.includes("name: 'dev-flow:dev-improve'"),
    "dev-flow-improve/SKILL.md に namespaced 起動記述 `name: 'dev-flow:dev-improve'` が見つからない",
  );
});

// (c) bare 名での起動記述が残っていない
test('[devimprove-skill-wrapper] bare 名 dev-improve での起動記述を含まない', () => {
  assert.ok(
    !src.includes("name: 'dev-improve'"),
    "dev-flow-improve/SKILL.md に bare 名での起動記述 `name: 'dev-improve'` が残存している（namespaced 名を使うこと）",
  );
});

// (d) workflow 実体のパスが plugin 配下を指す
test('[devimprove-skill-wrapper] workflow 実体は plugins/dev-flow/.claude/workflows/dev-improve.js を指す', () => {
  assert.ok(
    src.includes('plugins/dev-flow/.claude/workflows/dev-improve.js'),
    'dev-flow-improve/SKILL.md の workflow パスが plugins/dev-flow/ 配下を指していない',
  );
});
