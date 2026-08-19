// dev-flow.js の workflow meta.name rename ('dev-flow' -> 'dev-flow-run') を静的検証する。
//
// 背景: dev-flow.js の meta.name は skill 名（dev-flow/SKILL.md）と衝突しないよう
//       'dev-flow-run' へ改名する。一方、journal telemetry のキー `skill: 'dev-flow',`
//       （L2881 / L5897 の 2箇所）は集計の連続性のため絶対に変更しない（不変条件）。
//
// このテストは:
//   (a) meta.name === 'dev-flow-run' が存在すること
//   (b) 旧 meta 名 `name: 'dev-flow',`（完全一致文字列）が存在しないこと
//   (c) `skill: 'dev-flow',` の出現回数がちょうど 2 であること（telemetry 不変条件の pin）
//   (d) .claude/workflows/ 配下の全 *.js に workflow('dev-flow') 形式の nested 呼び出しが
//       存在しないこと（rename 漏れ検出）
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.claude/workflows');

const devFlowPath = join(workflowDir, 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// (a) 新 meta 名が存在する
test('[workflow-name] dev-flow.js: meta.name が dev-flow-run である', () => {
  assert.ok(
    devFlowSrc.includes("name: 'dev-flow-run',"),
    "dev-flow.js に name: 'dev-flow-run', が存在しない（meta.name の rename が未適用）",
  );
});

// (b) 旧 meta 名が存在しない
test('[workflow-name] dev-flow.js: 旧 meta 名 name: \'dev-flow\', が残存しない', () => {
  assert.ok(
    !devFlowSrc.includes("name: 'dev-flow',"),
    "dev-flow.js に旧 meta 名 name: 'dev-flow', が残存している（rename 漏れ）",
  );
});

// (c) telemetry の skill: 'dev-flow' はちょうど2箇所（不変条件）
test('[workflow-name] dev-flow.js: skill: \'dev-flow\', の telemetry キーがちょうど2箇所存在する（不変条件）', () => {
  const matches = devFlowSrc.match(/skill: 'dev-flow',/g) || [];
  assert.equal(
    matches.length,
    2,
    `dev-flow.js の skill: 'dev-flow', 出現回数は 2 であるべき（実測: ${matches.length}）。telemetry 集計の連続性のため変更禁止`,
  );
});

// (d) .claude/workflows/*.js に workflow('dev-flow') 形式の nested 呼び出しが無い
test('[workflow-name] .claude/workflows/*.js に workflow(\'dev-flow\') 形式の nested 呼び出しが存在しない', () => {
  const files = readdirSync(workflowDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, '.claude/workflows/ 配下に *.js が見つからない');

  const nestedCallPattern = /[Ww]orkflow\(\s*\{?\s*(name:\s*)?['"]dev-flow['"](?!-run)/;

  for (const file of files) {
    const filePath = join(workflowDir, file);
    const src = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      src,
      nestedCallPattern,
      `${file} に workflow('dev-flow') 形式の nested 呼び出しが残存している（rename 漏れ）`,
    );
  }
});
