import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkWorktreeBase, worktreeBaseProbePrompt, WORKTREE_BASE_PROBE } from './worktree-base-check.mjs';

// ── WORKTREE_BASE_PROBE ─────────────────────────────────────────────────────

test('WORKTREE_BASE_PROBE: required が期待通り', () => {
  assert.deepEqual(WORKTREE_BASE_PROBE.required, ['ok', 'worktree_exists', 'upstream']);
});

// ── worktreeBaseProbePrompt ──────────────────────────────────────────────────

test('worktreeBaseProbePrompt: --git-common-dir を含む（root 解決方式の pin）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /--git-common-dir/);
});

test('worktreeBaseProbePrompt: --show-toplevel を含まない（前回 critical の再発 pin）', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.doesNotMatch(prompt, /--show-toplevel/);
});

test('worktreeBaseProbePrompt: .claude/worktrees/df-517 を含む', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /\.claude\/worktrees\/df-517/);
});

test('worktreeBaseProbePrompt: @{upstream} を含む', () => {
  const prompt = worktreeBaseProbePrompt(517);
  assert.match(prompt, /@\{upstream\}/);
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

// ── checkWorktreeBase: 一致・不一致・判定不能 ────────────────────────────────

test('checkWorktreeBase: 一致（upstream origin/dev, base dev）→ status match', () => {
  const res = checkWorktreeBase({
    issue: 517,
    base: 'dev',
    probe: { ok: true, worktree_exists: true, upstream: 'origin/dev' },
  });
  assert.equal(res.status, 'match');
  assert.match(res.logLine, /worktree-base-check/);
});

test('checkWorktreeBase: 不一致（origin/main vs base dev）→ throw（origin/main と origin/dev と復旧手順を含む）', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream: 'origin/main' },
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

test('checkWorktreeBase: 判定不能（upstream 空文字列）→ throw + 復旧手順', () => {
  assert.throws(
    () => checkWorktreeBase({
      issue: 517,
      base: 'dev',
      probe: { ok: true, worktree_exists: true, upstream: '' },
    }),
    (err) => {
      assert.match(err.message, /git worktree remove/);
      assert.match(err.message, /--base/);
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
      probe: { ok: false, worktree_exists: true, upstream: 'origin/dev' },
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
    probe: { ok: true, worktree_exists: false, upstream: '' },
  });
  assert.equal(res.status, 'no_worktree');
  assert.match(res.logLine, /worktree-base-check/);
});

// ── checkWorktreeBase: base にスラッシュ含み ────────────────────────────────

test('checkWorktreeBase: base にスラッシュ含み（release/1.0）+ 一致 upstream → match', () => {
  const res = checkWorktreeBase({
    issue: 517,
    base: 'release/1.0',
    probe: { ok: true, worktree_exists: true, upstream: 'origin/release/1.0' },
  });
  assert.equal(res.status, 'match');
});
