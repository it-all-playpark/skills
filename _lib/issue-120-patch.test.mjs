// issue-120-patch.test.mjs
//
// docs/issue-120-dev-flow-setup-install.patch が正しい内容であることを保証する。
// F4 の patch 作成前は赤（readFileSync fail）、F4 後に緑。
//
// assertions:
//   (1) diff ヘッダに .claude/workflows/dev-flow.js を含む
//   (2) 追加行(行頭 +)に ensure-worktree-deps.sh と --path ${WT} を含む
//   (3) 追加行に dev-runner を含む
//   (4) env-setup 呼び出し行近傍 300 文字に need( が無い（非ブロッキング）
//   (5) コンテキスト行に WT = setup.worktree と phase Analyze が現れ、
//       ensure-worktree-deps.sh 追加行の indexOf が
//         WT = setup.worktree 行より後・phase Analyze 行より前（順序検証）
//   (6) 追加行に ENVSETUP と required を含む

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const patchPath = join(repoRoot, 'docs/issue-120-dev-flow-setup-install.patch');
const patch = readFileSync(patchPath, 'utf8');

// 行頭が + で始まる（diff ヘッダの +++ は除く）追加行を抽出
const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

test('(1) diff ヘッダに .claude/workflows/dev-flow.js を含む', () => {
  assert.ok(
    patch.includes('.claude/workflows/dev-flow.js'),
    'patch に .claude/workflows/dev-flow.js が見つからない',
  );
});

test('(2) 追加行に ensure-worktree-deps.sh と --path ${WT} を含む', () => {
  const ensureLine = addedLines.find(l => l.includes('ensure-worktree-deps.sh'));
  assert.ok(ensureLine, '追加行に ensure-worktree-deps.sh が見つからない');
  assert.ok(
    ensureLine.includes('--path') && ensureLine.includes('WT'),
    `追加行に --path WT が含まれていない: ${ensureLine}`,
  );
});

test('(3) 追加行に dev-runner を含む', () => {
  const devRunnerLine = addedLines.find(l => l.includes('dev-runner'));
  assert.ok(devRunnerLine, '追加行に dev-runner が見つからない');
});

test('(4) env-setup 呼び出し行近傍 300 文字に need( が無い（非ブロッキング）', () => {
  const envSetupIdx = patch.indexOf('env-setup');
  assert.ok(envSetupIdx !== -1, 'patch に env-setup が見つからない');
  const start = Math.max(0, envSetupIdx - 150);
  const end = Math.min(patch.length, envSetupIdx + 150);
  const vicinity = patch.slice(start, end);
  assert.ok(
    !vicinity.includes('need('),
    `env-setup 近傍 300 文字に need( が含まれている（ブロッキング呼び出し）: ...${vicinity}...`,
  );
});

test('(5) ensure-worktree-deps.sh 挿入位置が WT = setup.worktree より後・Phase Analyze より前', () => {
  // patch ファイルの先頭はコメントヘッダ（# で始まる説明行）。
  // 比較は "diff --git" 以降の実 diff 部分のみで行う。
  const diffStart = patch.indexOf('diff --git');
  assert.ok(diffStart !== -1, 'patch に diff --git が見つからない（正しい unified diff 形式でない）');
  const diffBody = patch.slice(diffStart);

  // コンテキスト行: " WT = setup.worktree"（行頭スペースは patch フォーマットで変更なし行）
  const wtIdx = diffBody.indexOf('WT = setup.worktree');
  assert.ok(wtIdx !== -1, 'diff 本文に WT = setup.worktree が見つからない');

  // Analyze フェーズの区切りコメント: "// Phase Analyze:"
  const analyzeIdx = diffBody.indexOf('// Phase Analyze:');
  assert.ok(analyzeIdx !== -1, 'diff 本文に // Phase Analyze: が見つからない');

  // 追加行内の ensure-worktree-deps.sh（"+" 行に含まれる）
  const ensureIdx = diffBody.indexOf('ensure-worktree-deps.sh');
  assert.ok(ensureIdx !== -1, 'diff 本文に ensure-worktree-deps.sh が見つからない');

  assert.ok(
    ensureIdx > wtIdx,
    `ensure-worktree-deps.sh (idx=${ensureIdx}) が WT = setup.worktree (idx=${wtIdx}) より前にある`,
  );
  assert.ok(
    ensureIdx < analyzeIdx,
    `ensure-worktree-deps.sh (idx=${ensureIdx}) が // Phase Analyze: (idx=${analyzeIdx}) より後にある`,
  );
});

test('(6) 追加行に ENVSETUP と required を含む', () => {
  const envsetupLine = addedLines.find(l => l.includes('ENVSETUP'));
  assert.ok(envsetupLine, '追加行に ENVSETUP が見つからない');

  const requiredLine = addedLines.find(l => l.includes('required'));
  assert.ok(requiredLine, '追加行に required が見つからない');
});
