// Regression test: mktemp が TMPDIR フォールバック形式を使うことを保証する。
//
// 問題: `mktemp /tmp/...` はサンドボックス環境（macOS の Claude Code sandbox 等）では
//       /tmp への書き込みが拒否されて失敗する。$TMPDIR 環境変数を参照する形式
//       `mktemp "${TMPDIR:-/tmp}/..."` を使えばサンドボックスが許可した一時ディレクトリを使える。
//
// このテストは:
//   (a) dev-flow.js / pr-iterate.js に `mktemp /tmp/` という古い形式が残存しないこと
//   (b) dev-flow.js に mktemp "\${TMPDIR:-/tmp}/dev-flow-XXXXXX.md" が含まれること
//   (c) pr-iterate.js に mktemp "\${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md" が含まれること
// を assert する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.claude/workflows');

const devFlowPath = join(workflowDir, 'dev-flow.js');
const prIteratePath = join(workflowDir, 'pr-iterate.js');

const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(prIteratePath, 'utf8');

// (a) 旧形式 `mktemp /tmp/` が残存しないこと
test('[tmpdir] dev-flow.js: `mktemp /tmp/` という旧形式が含まれない', () => {
  assert.ok(
    !devFlowSrc.includes('mktemp /tmp/'),
    'dev-flow.js に `mktemp /tmp/` が残存している（TMPDIR フォールバック形式へ移行すること）',
  );
});

test('[tmpdir] pr-iterate.js: `mktemp /tmp/` という旧形式が含まれない', () => {
  assert.ok(
    !prIterateSrc.includes('mktemp /tmp/'),
    'pr-iterate.js に `mktemp /tmp/` が残存している（TMPDIR フォールバック形式へ移行すること）',
  );
});

// (b) dev-flow.js に新形式が含まれること
// bodySaveInstr がパラメータ化されたため、ソース内の形式は:
//   mktemp "\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md"
// に変わった。呼び出し側では bodySaveInstr(body, 'dev-flow', ...) を確認する。
test('[tmpdir] dev-flow.js: TMPDIR フォールバック形式の mktemp が含まれる', () => {
  assert.ok(
    devFlowSrc.includes('mktemp "\\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md"'),
    'dev-flow.js に mktemp "\\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md" が存在しない（TMPDIR フォールバック形式が必要）',
  );
  assert.ok(
    devFlowSrc.includes("'dev-flow'"),
    "dev-flow.js に bodySaveInstr の 'dev-flow' prefix が存在しない",
  );
});

// (c) pr-iterate.js に新形式が含まれること
// 同様に bodySaveInstr がパラメータ化されており、呼び出し側の prefix 'pr-iterate' を確認する。
test('[tmpdir] pr-iterate.js: TMPDIR フォールバック形式の mktemp が含まれる', () => {
  assert.ok(
    prIterateSrc.includes('mktemp "\\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md"'),
    'pr-iterate.js に mktemp "\\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md" が存在しない（TMPDIR フォールバック形式が必要）',
  );
  assert.ok(
    prIterateSrc.includes("'pr-iterate'"),
    "pr-iterate.js に bodySaveInstr の 'pr-iterate' prefix が存在しない",
  );
});
