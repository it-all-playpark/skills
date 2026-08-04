import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isolationProbePrompt, isolationFailureMessage } from './isolation-probe.mjs';

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

// ── issue #482: stale probe artifact による恒久 fail-closed の解消（冪等化） ─────

test('isolationProbePrompt: 既存ファイル時は Read tool で先に読んでから Write する冪等化指示を含む', () => {
  const prompt = isolationProbePrompt('/path/to/worktree');
  assert.match(prompt, /Read tool/);
  assert.match(prompt, /既に存在する場合/);
});

test('isolationProbePrompt: written は Write の成否のみで報告させ Read の成否を混ぜない指示を含む', () => {
  const prompt = isolationProbePrompt('/path/to/worktree');
  assert.match(prompt, /Read が失敗しても Write は必ず試み/);
  assert.match(prompt, /Write の結果のみで written を報告/);
});

test('isolationFailureMessage: stale な probe artifact の可能性とフルパスに言及する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-482', branch: 'feature/issue-482', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '482', error: 'EPERM: denied',
  });
  assert.match(msg, /stale/);
  assert.match(msg, /\/repo\/\.claude\/worktrees\/df-482\/\.devflow-tmp\/\.isolation-probe/);
});

test('isolationFailureMessage: rm / git clean が sandbox・permission で不可な場合の Read→Write 上書き代替手順を含む', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-482', branch: 'feature/issue-482', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '482', error: 'EPERM: denied',
  });
  assert.match(msg, /rm/);
  assert.match(msg, /git clean/);
  assert.match(msg, /Read tool/);
  assert.match(msg, /Write tool/);
});
