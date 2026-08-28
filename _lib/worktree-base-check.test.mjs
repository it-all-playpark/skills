import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkWorktreeBase, worktreeBaseProbePrompt, WORKTREE_BASE_PROBE } from './worktree-base-check.mjs';

// ── WORKTREE_BASE_PROBE ─────────────────────────────────────────────────────

test('WORKTREE_BASE_PROBE: required が期待通り（issue #527: upstream_remote/upstream_merge 分割）', () => {
  assert.deepEqual(WORKTREE_BASE_PROBE.required, ['ok', 'worktree_exists', 'upstream_remote', 'upstream_merge']);
});

// ── worktreeBaseProbePrompt ──────────────────────────────────────────────────

test('worktreeBaseProbePrompt: git worktree list --porcelain を含む（issue #527: パス引数ゼロ構成）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /`git worktree list --porcelain`/);
});

test('worktreeBaseProbePrompt: git config --get branch. を含む（issue #527: パス引数ゼロ構成）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /`git config --get branch\.<BR>\.remote`/);
  assert.match(prompt, /`git config --get branch\.<BR>\.merge`/);
});

test('worktreeBaseProbePrompt: git -C の実行コマンドを含まない（worktree-isolation guard 拒否の再発 pin, issue #527）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.doesNotMatch(prompt, /`git -C /);
});

test('worktreeBaseProbePrompt: test -d の実行コマンドを含まない（worktree-isolation guard 拒否の再発 pin, issue #527）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.doesNotMatch(prompt, /`test -d/);
});

test('worktreeBaseProbePrompt: @{upstream} を含まない（issue #527: git config --get へ置換）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.doesNotMatch(prompt, /@\{upstream\}/);
});

test('worktreeBaseProbePrompt: .claude/worktrees/df-517 を含む', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /\.claude\/worktrees\/df-517/);
});

test('worktreeBaseProbePrompt: repo 外候補 <repo>-wt/df-517 を含む（issue #528: 2候補化）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /-wt\/df-517/);
});

test('worktreeBaseProbePrompt: WTD_IN が常に先勝ちする旨の文言を含む（issue #528 不変条件）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /先勝ち/);
});

test('worktreeBaseProbePrompt: verbatim を含む', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /verbatim/);
});

test('worktreeBaseProbePrompt: Output format / Tools / Boundary / Token cap セクションを含む', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /## Output format/);
  assert.match(prompt, /## Tools/);
  assert.match(prompt, /## Boundary/);
  assert.match(prompt, /## Token cap/);
});

test('worktreeBaseProbePrompt: Output format が upstream_remote/upstream_merge を含む新 JSON 形式である', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /\{"ok":true,"worktree_exists":<bool>,"upstream_remote":"<string>","upstream_merge":"<string>"\}/);
});

test('worktreeBaseProbePrompt: ネストした command substitution $( を含まない（worktree-isolation guard 拒否の再発 pin, issue #519 review）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.doesNotMatch(prompt, /\$\(/);
});

test('worktreeBaseProbePrompt: 複合 if 文（if [ ... ]）を含まない（worktree-isolation guard 拒否の再発 pin, issue #519 review）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.doesNotMatch(prompt, /if \[/);
});

test('worktreeBaseProbePrompt: Tools セクションが git -C・test を禁止する旨を明示する（issue #527）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /`git -C`/);
  assert.match(prompt, /`test`/);
});

// ── checkWorktreeBase: 一致・不一致・判定不能（新 probe shape: upstream_remote/upstream_merge） ──

test('checkWorktreeBase: 一致（remote:origin, merge:refs/heads/dev, base dev）→ status match', () => {
  const res = checkWorktreeBase({
    issue: 517,
    base: 'dev',
    probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/dev' },
  });
  assert.equal(res.status, 'match');
  assert.match(res.logLine, /worktree-base-check/);
});

test('checkWorktreeBase: merge が refs/heads/feature/issue-<issue>（PR 作成済み push -u 済み）→ status match_pushed（throw しない）', () => {
  const res = checkWorktreeBase({
    issue: 517,
    base: 'dev',
    probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/feature/issue-517' },
  });
  assert.equal(res.status, 'match_pushed');
  assert.match(res.logLine, /worktree-base-check/);
  assert.match(res.logLine, /origin\/feature\/issue-517/);
});

test('checkWorktreeBase: 不一致（remote:origin, merge:refs/heads/main, base dev）→ throw（origin/main と origin/dev と復旧手順を含む）', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/main' },
    }),
    (err) => {
      assert.match(err.message, /origin\/main/);
      assert.match(err.message, /origin\/dev/);
      assert.match(err.message, /git worktree remove/);
      assert.match(err.message, /--base/);
      return true;
    },
  );
});

test('checkWorktreeBase: 不一致 → throw メッセージが repo 外配置の削除パス（-wt/df-）を含む（issue #528: 2候補化）', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/main' },
    }),
    (err) => {
      assert.match(err.message, /-wt\/df-/);
      return true;
    },
  );
});

test('checkWorktreeBase: upstream_remote が空文字列（branch config 未設定）→ throw + 復旧手順', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream_remote: '', upstream_merge: 'refs/heads/dev' },
    }),
    (err) => {
      assert.match(err.message, /git worktree remove/);
      assert.match(err.message, /--base/);
      return true;
    },
  );
});

test('checkWorktreeBase: upstream_merge が空文字列（branch config 未設定）→ throw + 復旧手順', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: '' },
    }),
    (err) => {
      assert.match(err.message, /git worktree remove/);
      assert.match(err.message, /--base/);
      return true;
    },
  );
});

test('checkWorktreeBase: upstream_remote/upstream_merge 両方空文字列 → throw メッセージが repo 外配置の削除パス（-wt/df-）を含む', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream_remote: '', upstream_merge: '' },
    }),
    (err) => {
      assert.match(err.message, /-wt\/df-/);
      return true;
    },
  );
});

test('checkWorktreeBase: merge が refs/heads/ 接頭辞を持たない（例 refs/pull/1/head）→ as-is 合成で不一致 throw（誤 match しない）', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/pull/1/head' },
    }),
    (err) => {
      assert.match(err.message, /origin\/refs\/pull\/1\/head/);
      return true;
    },
  );
});

// ── checkWorktreeBase: probe 不正 ────────────────────────────────────────────

test('checkWorktreeBase: probe null → throw（fail-closed）', () => {
  assert.throws(
    () => checkWorktreeBase({ issue: 517, base: 'dev', probe: null }),
    /dev-flow: 既存 worktree の起点を確認できなかった/,
  );
});

test('checkWorktreeBase: probe.ok:false → throw', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: false, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/dev' },
    }),
    /dev-flow: 既存 worktree の起点を確認できなかった/,
  );
});

test('checkWorktreeBase: probe が非 object（文字列） → throw', () => {
  assert.throws(
    () => checkWorktreeBase({ issue: 517, base: 'dev', probe: 'not an object' }),
    /dev-flow: 既存 worktree の起点を確認できなかった/,
  );
});

test('checkWorktreeBase: probe が配列 → throw', () => {
  assert.throws(
    () => checkWorktreeBase({ issue: 517, base: 'dev', probe: [] }),
    /dev-flow: 既存 worktree の起点を確認できなかった/,
  );
});

// ── checkWorktreeBase: no_worktree ───────────────────────────────────────────

test('checkWorktreeBase: worktree_exists:false → status no_worktree（throw しない）', () => {
  const res = checkWorktreeBase({
    issue: 517,
    base: 'dev',
    probe: { ok: true, worktree_exists: false, upstream_remote: '', upstream_merge: '' },
  });
  assert.equal(res.status, 'no_worktree');
  assert.match(res.logLine, /worktree-base-check/);
});

// ── checkWorktreeBase: base にスラッシュ含み ────────────────────────────────

test('checkWorktreeBase: base にスラッシュ含み（release/1.0）+ 一致 upstream → match', () => {
  const res = checkWorktreeBase({
    issue: 517,
    base: 'release/1.0',
    probe: { ok: true, worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/release/1.0' },
  });
  assert.equal(res.status, 'match');
});
