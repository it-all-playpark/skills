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

test('isolationFailureMessage: worktree/branch/base/issue を含む復旧手順を返す', () => {
  const msg = isolationFailureMessage('/repo/.claude/worktrees/df-123', 'feature/issue-123', 'main', '123', 'Permission denied');
  assert.match(msg, /\/repo\/\.claude\/worktrees\/df-123/);
  assert.match(msg, /feature\/issue-123/);
  assert.match(msg, /origin\/main/);
  assert.match(msg, /Workflow\(\{ name: "dev-flow", args: "123" \}\)/);
});

test('isolationFailureMessage: git worktree add / EnterWorktree / Workflow 再実行の3手順を番号付きで含む', () => {
  const msg = isolationFailureMessage('/repo/.claude/worktrees/df-1', 'feature/issue-1', 'dev', '1', 'err');
  assert.match(msg, /1\. git worktree add -b feature\/issue-1/);
  assert.match(msg, /2\. EnterWorktree\(/);
  assert.match(msg, /3\. Workflow\(/);
});

test('isolationFailureMessage: EnterWorktree の path は .claude/worktrees/ 以降の相対パスに変換される', () => {
  const msg = isolationFailureMessage('/Users/x/ghq/github.com/o/r/.claude/worktrees/df-42', 'feature/issue-42', 'main', '42', '');
  assert.match(msg, /EnterWorktree\(\{ path: "\.claude\/worktrees\/df-42" \}\)/);
  assert.doesNotMatch(msg, /path: "\/Users\/x\/ghq/);
});

test('isolationFailureMessage: .claude/worktrees/ を含まない worktree パスはそのまま使われる', () => {
  const msg = isolationFailureMessage('/tmp/some-other-wt', 'feature/issue-9', 'main', '9', '');
  assert.match(msg, /EnterWorktree\(\{ path: "\/tmp\/some-other-wt" \}\)/);
});

test('isolationFailureMessage: error が非空なら probe error を末尾に含む', () => {
  const msg = isolationFailureMessage('/wt', 'b', 'main', '1', 'EPERM: denied');
  assert.match(msg, /probe error: EPERM: denied/);
});

test('isolationFailureMessage: error が空文字なら probe error 行を含まない', () => {
  const msg = isolationFailureMessage('/wt', 'b', 'main', '1', '');
  assert.doesNotMatch(msg, /probe error:/);
});

test('isolationFailureMessage: bg-isolation guard の可能性に言及する', () => {
  const msg = isolationFailureMessage('/wt', 'b', 'main', '1', '');
  assert.match(msg, /bg-isolation guard/);
});
