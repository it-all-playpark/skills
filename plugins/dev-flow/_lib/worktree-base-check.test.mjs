import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkWorktreeBase } from './worktree-base-check.mjs';

// WORKTREE_BASE_PROBE / worktreeBaseProbePrompt は issue #550 案1 で resolve-base.mjs の
// SETUP_BASE_PROBE / setupBaseProbePrompt へ統合された（_lib/resolve-base.test.mjs 側でテストする）。
// checkWorktreeBase は probe object の worktree_exists/upstream_remote/upstream_merge フィールドのみ
// を読む決定論関数であり、統合後も無変更のため以下のテストは全て有効。

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
