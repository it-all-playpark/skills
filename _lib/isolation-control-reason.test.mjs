// isolation-control-reason.test.mjs
//
// isolation probe の prompt / throw メッセージが、実行制御の名称（sandbox・permission・
// excludedCommands・guard 等）を「だからこの経路を使え」という形の理由として述べていないことを
// pin する静的テスト（issue #493 AC-4）。
//
// `.claude/rules/dev-flow.md` の exec-proxy 節は「prompt に sandbox / excludedCommands /
// 特定パス起動の理由を書いてはならない。**例外はない**」と定めている（issue #458 の帰結）。
// isolationFailureMessage は prompt ではないが throw メッセージとして呼び出し元セッションの
// context に入り（bg job では task-notification として転写される）、次の run の prompt と合成して
// 判定されるため、同じ規範を適用する。
//
// 検査対象は canonical（_lib/isolation-probe.mjs の関数出力）と、そこから生成される
// .claude/workflows/{dev-flow,pr-iterate}.js の inline 区間の双方。inline 側はコメント行を
// 除去してから検査する（コメントは prompt 文字列ではなく、規範そのものの説明を含みうるため）。
//
// 許容: 'bg-isolation guard の可能性' — これは失敗の診断（何が起きたか）であって、
// 「制御が塞いでいるから別経路を使え」という指示ではない。診断の削除は issue #493 の非目標。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isolationCleanupPrompt, isolationProbePrompt, isolationFailureMessage } from './isolation-probe.mjs';
// isolationErrorKind は prompt/メッセージ文字列を生成しないため（純粋な分類関数）、
// このファイルの検査対象（FORBIDDEN スキャン）には含めない。

const here = dirname(fileURLToPath(import.meta.url));

// 「制御 X が塞いでいる／X を避けるため」という形の理由記述を検出するパターン。
// 実行制御の固有名詞と、迂回・代替経路を示唆する語を対象にする。
const FORBIDDEN = [
  { re: /sandbox/i, why: '実行制御名 sandbox' },
  { re: /excludedCommands/i, why: '設定名 excludedCommands' },
  { re: /permission/i, why: '実行制御名 permission' },
  { re: /パーミッション/, why: '実行制御名 permission（カナ）' },
  { re: /\bEPERM\b/, why: '制御由来のエラー名 EPERM' },
  { re: /迂回/, why: '迂回の明示' },
  { re: /代替手順/, why: '代替経路の提示' },
  { re: /拒否されることがあるため/, why: '「制御が拒否するから別経路を使え」型の理由記述' },
];

// 診断としての guard 言及のみ許容し、それ以外の 'guard' は禁止する。
const ALLOWED_GUARD_MENTION = 'bg-isolation guard';

function assertNoControlReason(text, label) {
  for (const { re, why } of FORBIDDEN) {
    assert.doesNotMatch(text, re, `${label} に禁止パターン（${why}）が含まれている`);
  }
  const withoutAllowed = text.split(ALLOWED_GUARD_MENTION).join('');
  assert.doesNotMatch(
    withoutAllowed,
    /guard/i,
    `${label} に '${ALLOWED_GUARD_MENTION}'（診断）以外の guard 言及が含まれている`,
  );
}

// ---- canonical（関数出力） ----

const CANONICAL_SAMPLES = [
  ['isolationCleanupPrompt(dir)', isolationCleanupPrompt('/repo/.claude/worktrees/df-1', '.devflow-tmp')],
  ['isolationCleanupPrompt(file)', isolationCleanupPrompt('/repo', '.devflow-tmp/.isolation-probe')],
  ['isolationProbePrompt', isolationProbePrompt('/repo/.claude/worktrees/df-1', '1787000000')],
  // error は呼び出し元が受け取った probe error を verbatim 転写する引数であり、
  // 関数側の記述ではない。関数自身の文言だけを検査するため、kind を切り替えるのに必要な
  // 最小限の分類シグネチャ以外は空文字で構築する。
  ['isolationFailureMessage(dev-flow, unknown)', isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-1', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '1', error: '',
  })],
  ['isolationFailureMessage(pr-iterate, unknown)', isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-1', startRef: 'origin/feature/issue-1',
    workflowName: 'pr-iterate', workflowArgs: '1', targetPath: '/repo/.claude/worktrees/pr-1', error: '',
  })],
  ['isolationFailureMessage(dev-flow, isolation)', isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-1', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '1', error: "parent bg session hasn't isolated",
  })],
  ['isolationFailureMessage(dev-flow, overwrite_refused)', isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-1', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '1',
    error: 'File has not been read yet. Read it first before writing to it.',
  })],
];

for (const [label, text] of CANONICAL_SAMPLES) {
  test(`[isolation-control-reason] canonical ${label} が実行制御の理由記述を含まない`, () => {
    assertNoControlReason(text, label);
  });
}

// ---- inline 生成区間（両 workflow） ----

const INLINE_TARGETS = [
  '.claude/workflows/dev-flow.js',
  '.claude/workflows/pr-iterate.js',
];

const BEGIN = '// ==== BEGIN inline: _lib/isolation-probe.mjs';
const END = '// ==== END inline: _lib/isolation-probe.mjs ====';

function extractInlineRegion(relPath) {
  const src = readFileSync(join(here, '..', relPath), 'utf8');
  const start = src.indexOf(BEGIN);
  assert.ok(start >= 0, `${relPath} に isolation-probe の inline 開始マーカーが見つからない`);
  const end = src.indexOf(END, start);
  assert.ok(end >= 0, `${relPath} に isolation-probe の inline 終了マーカーが見つからない`);
  return src.slice(start, end + END.length);
}

// コメント行（行頭空白 + //）を落とし、prompt 文字列を含むコード行のみを残す。
function stripCommentLines(region) {
  return region.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

for (const relPath of INLINE_TARGETS) {
  test(`[isolation-control-reason] ${relPath} の inline 区間が 3 関数を含む`, () => {
    const code = stripCommentLines(extractInlineRegion(relPath));
    assert.match(code, /function isolationCleanupPrompt\(/);
    assert.match(code, /function isolationProbePrompt\(/);
    assert.match(code, /function isolationFailureMessage\(/);
  });

  test(`[isolation-control-reason] ${relPath} の inline 区間が実行制御の理由記述を含まない`, () => {
    const code = stripCommentLines(extractInlineRegion(relPath));
    assertNoControlReason(code, `${relPath} の inline 区間`);
  });
}
