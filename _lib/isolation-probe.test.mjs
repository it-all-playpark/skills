import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isolationCleanupPrompt, isolationProbePrompt, isolationFailureMessage } from './isolation-probe.mjs';

// ── isolationProbePrompt ────────────────────────────────────────────────────

test('isolationProbePrompt: worktree パスと probe ファイル名・成功/失敗の verbatim 報告指示を含む', () => {
  const prompt = isolationProbePrompt('/path/to/worktree');
  assert.match(prompt, /\/path\/to\/worktree/);
  assert.match(prompt, /\.devflow-tmp\/\.isolation-probe/);
  assert.match(prompt, /Write tool/);
  assert.match(prompt, /"written": true/);
  assert.match(prompt, /"written": false/);
});

test('isolationProbePrompt: 失敗時は例外を投げず error フィールドで報告させる指示を含む', () => {
  const prompt = isolationProbePrompt('/some/wt');
  assert.match(prompt, /例外を投げずに/);
  assert.match(prompt, /"error"/);
});

// ── isolationFailureMessage ─────────────────────────────────────────────────

test('isolationFailureMessage: worktree/branch/startRef/workflow 名/args を含む復旧手順を返す', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-123', branch: 'feature/issue-123', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '123', error: 'Permission denied',
  });
  assert.match(msg, /\/repo\/\.claude\/worktrees\/df-123/);
  assert.match(msg, /feature\/issue-123/);
  assert.match(msg, /origin\/main/);
  assert.match(msg, /Workflow\(\{ name: "dev-flow", args: "123" \}\)/);
});

test('isolationFailureMessage: workflow 名/args は呼び出し元ごとに切り替わる（pr-iterate）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'pr-iterate', workflowArgs: '455', error: '',
  });
  assert.match(msg, /^pr-iterate: worktree isolation エラー/);
  assert.match(msg, /pr-iterate を再起動してください/);
  assert.match(msg, /Workflow\(\{ name: "pr-iterate", args: "455" \}\)/);
});

test('isolationFailureMessage: git worktree add / EnterWorktree / Workflow 再実行の3手順を番号付きで含む', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-1', branch: 'feature/issue-1', startRef: 'origin/dev',
    workflowName: 'dev-flow', workflowArgs: '1', error: 'err',
  });
  assert.match(msg, /1\. git worktree add -b feature\/issue-1/);
  assert.match(msg, /2\. EnterWorktree\(/);
  assert.match(msg, /3\. Workflow\(/);
});

test('isolationFailureMessage: EnterWorktree の path は .claude/worktrees/ 以降の相対パスに変換される', () => {
  const msg = isolationFailureMessage({
    worktree: '/Users/x/ghq/github.com/o/r/.claude/worktrees/df-42', branch: 'feature/issue-42', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '42', error: '',
  });
  assert.match(msg, /EnterWorktree\(\{ path: "\.claude\/worktrees\/df-42" \}\)/);
  assert.doesNotMatch(msg, /path: "\/Users\/x\/ghq/);
});

test('isolationFailureMessage: .claude/worktrees/ を含まない worktree パスはそのまま使われる', () => {
  const msg = isolationFailureMessage({
    worktree: '/tmp/some-other-wt', branch: 'feature/issue-9', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '9', error: '',
  });
  assert.match(msg, /EnterWorktree\(\{ path: "\/tmp\/some-other-wt" \}\)/);
});

test('isolationFailureMessage: targetPath 指定時は worktree（書き込み失敗先）と異なる先を回避手順に提示する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-455', startRef: 'origin/main',
    workflowName: 'pr-iterate', workflowArgs: '455', error: '',
    targetPath: '/repo/.claude/worktrees/pr-455',
  });
  assert.match(msg, /implementer が \/repo に書き込めません/);
  assert.match(msg, /1\. git worktree add -b feature\/issue-455 \/repo\/\.claude\/worktrees\/pr-455/);
  assert.match(msg, /EnterWorktree\(\{ path: "\.claude\/worktrees\/pr-455" \}\)/);
  assert.doesNotMatch(msg, /git worktree add -b feature\/issue-455 \/repo origin/);
});

test('isolationFailureMessage: branch 既存時の代替コマンドを案内する（pr-iterate では head_ref がローカル既存になりやすい）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-449', startRef: 'origin/feature/issue-449',
    workflowName: 'pr-iterate', workflowArgs: '455', error: '',
    targetPath: '/repo/.claude/worktrees/pr-455',
  });
  assert.match(msg, /git worktree add \/repo\/\.claude\/worktrees\/pr-455 feature\/issue-449/);
  assert.match(msg, /worktree \/repo\/\.claude\/worktrees\/pr-455 自体が既存なら本手順ごと不要/);
  // branch が他 worktree で checkout 済み（実測 #417 の「cwd が df-<issue> のまま未 isolate」）だと
  // 上記フォールバックも already checked out で拒否されるため --force 版まで案内する。
  assert.match(msg, /git worktree add --force \/repo\/\.claude\/worktrees\/pr-455 feature\/issue-449/);
});

test('isolationFailureMessage: startRef は verbatim で使われる（関数側で origin/ を補わない）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-7', branch: 'feature/issue-7', startRef: 'upstream/release-1.x',
    workflowName: 'dev-flow', workflowArgs: '7', error: '',
  });
  assert.match(msg, /git worktree add -b feature\/issue-7 \/repo\/\.claude\/worktrees\/df-7 upstream\/release-1\.x/);
  assert.doesNotMatch(msg, /origin\/upstream/);
});

test('isolationFailureMessage: pr-iterate は PR head 起点を提示できる（base 起点だと PR の変更を含まない）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-449', startRef: 'origin/feature/issue-449',
    workflowName: 'pr-iterate', workflowArgs: '455', error: '',
    targetPath: '/repo/.claude/worktrees/pr-455',
  });
  assert.match(msg, /1\. git worktree add -b feature\/issue-449 \/repo\/\.claude\/worktrees\/pr-455 origin\/feature\/issue-449/);
  assert.doesNotMatch(msg, /origin\/main/);
});

test('isolationFailureMessage: error が非空なら probe error を末尾に含む', () => {
  const msg = isolationFailureMessage({
    worktree: '/wt', branch: 'b', startRef: 'origin/main', workflowName: 'dev-flow', workflowArgs: '1', error: 'EPERM: denied',
  });
  assert.match(msg, /probe error: EPERM: denied/);
});

test('isolationFailureMessage: error が空文字なら probe error 行を含まない', () => {
  const msg = isolationFailureMessage({
    worktree: '/wt', branch: 'b', startRef: 'origin/main', workflowName: 'dev-flow', workflowArgs: '1', error: '',
  });
  assert.doesNotMatch(msg, /probe error:/);
});

test('isolationFailureMessage: bg-isolation guard の可能性に言及する', () => {
  const msg = isolationFailureMessage({
    worktree: '/wt', branch: 'b', startRef: 'origin/main', workflowName: 'dev-flow', workflowArgs: '1', error: '',
  });
  assert.match(msg, /bg-isolation guard/);
});

// ── issue #493: stale 残置物の除去は cleanup へ分離し probe prompt を最小契約に戻す ─────
//
// issue #482 は「stale な .devflow-tmp/.isolation-probe があると Write が拒否され written:false →
// fail-closed abort する」問題に対し probe prompt 側の Read-then-Write 冪等化で対処していた。
// issue #493 で除去自体を probe 実行前の cleanup（gitignored な .devflow-tmp/ 限定の git clean）へ
// 移したため、probe prompt からは冪等化手順を落とす。#482 の再発が起きないこと（cleanup 実行後に
// stale artifact が残らないこと）は _lib/isolation-stale-cleanup.integration.test.mjs が実 git で検証する。

test('isolationProbePrompt: Read-then-Write 冪等化手順を含まない（cleanup へ分離した）', () => {
  const prompt = isolationProbePrompt('/path/to/worktree');
  assert.doesNotMatch(prompt, /Read tool/);
  assert.doesNotMatch(prompt, /既に存在する場合/);
  assert.doesNotMatch(prompt, /Read が失敗しても/);
});

test('isolationProbePrompt: Write は 1 回だけの最小契約になっている', () => {
  const prompt = isolationProbePrompt('/path/to/worktree');
  // Write tool への言及は「書き込め」と「エラー・拒否を返した場合」の 2 箇所のみ（手順分岐なし）
  assert.strictEqual((prompt.match(/Write tool/g) || []).length, 2);
  assert.match(prompt, /内容 "ok" で書き込め/);
});

test('isolationCleanupPrompt: worktree 直下の .devflow-tmp を git clean で除去させる', () => {
  const prompt = isolationCleanupPrompt('/repo/.claude/worktrees/df-493');
  assert.match(prompt, /git -C \/repo\/\.claude\/worktrees\/df-493 clean -fdx -- \.devflow-tmp/);
  assert.match(prompt, /gitignored/);
});

test('isolationCleanupPrompt: 除去対象を .devflow-tmp に限定する指示を含む', () => {
  const prompt = isolationCleanupPrompt('/wt');
  assert.match(prompt, /`\.devflow-tmp` 以外のパスには触れるな/);
});

test('isolationCleanupPrompt: 存在しない場合も成功する旨を明示する（no-op 冪等）', () => {
  const prompt = isolationCleanupPrompt('/wt');
  assert.match(prompt, /存在しない場合もこのコマンドは成功する/);
});

test('isolationCleanupPrompt: 失敗時は例外を投げず cleaned:false + error で報告させる', () => {
  const prompt = isolationCleanupPrompt('/wt');
  assert.match(prompt, /"cleaned": true/);
  assert.match(prompt, /"cleaned": false/);
  assert.match(prompt, /例外を投げずに/);
  assert.match(prompt, /"error"/);
});

test('isolationFailureMessage: 新しい worktree を作れば残置物起因のケースも解消する旨を案内する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-493', branch: 'feature/issue-493', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '493', error: '',
  });
  assert.match(msg, /新しい worktree には前 run の残置物が無い/);
});
