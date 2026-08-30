import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  normalizeBaseArg, resolveBase, setupBaseProbePrompt, SETUP_BASE_PROBE,
} from './resolve-base.mjs';
import { checkWorktreeBase } from './worktree-base-check.mjs';

// ── normalizeBaseArg ────────────────────────────────────────────────────────

test('normalizeBaseArg: null → null', () => {
  assert.equal(normalizeBaseArg(null), null);
});

test('normalizeBaseArg: undefined → null', () => {
  assert.equal(normalizeBaseArg(undefined), null);
});

test('normalizeBaseArg: 空白のみの文字列 → null', () => {
  assert.equal(normalizeBaseArg('  '), null);
});

test('normalizeBaseArg: 前後空白付き文字列 → trim される', () => {
  assert.equal(normalizeBaseArg(' main '), 'main');
});

test('normalizeBaseArg: 非空文字列 → そのまま返す', () => {
  assert.equal(normalizeBaseArg('release/1.0'), 'release/1.0');
});

test('normalizeBaseArg: 数値 → throw', () => {
  assert.throws(() => normalizeBaseArg(120), /dev-flow: args\.base は非空文字列で指定せよ/);
});

test('normalizeBaseArg: object → throw', () => {
  assert.throws(() => normalizeBaseArg({ base: 'main' }), /dev-flow: args\.base は非空文字列で指定せよ/);
});

test('normalizeBaseArg: コマンド置換 $(...) を含む → throw（shell injection 対策）', () => {
  assert.throws(
    () => normalizeBaseArg('x$(whoami)'),
    /dev-flow: args\.base に使用できない文字が含まれる/,
  );
});

test('normalizeBaseArg: ダブルクォートを含む → throw', () => {
  assert.throws(
    () => normalizeBaseArg('main"; rm -rf /; echo "'),
    /dev-flow: args\.base に使用できない文字が含まれる/,
  );
});

test('normalizeBaseArg: バッククォートを含む → throw', () => {
  assert.throws(
    () => normalizeBaseArg('x`whoami`'),
    /dev-flow: args\.base に使用できない文字が含まれる/,
  );
});

test('normalizeBaseArg: 先頭がハイフン → throw', () => {
  assert.throws(
    () => normalizeBaseArg('-rf'),
    /dev-flow: args\.base に使用できない文字が含まれる/,
  );
});

// ── SETUP_BASE_PROBE（issue #550 案1: resolve-base + worktree-base-check 統合 schema） ──────

test('SETUP_BASE_PROBE: required が両系フィールドを含む', () => {
  assert.deepEqual(SETUP_BASE_PROBE.required, [
    'ok', 'default_branch', 'dev_exists', 'requested_exists',
    'worktree_exists', 'upstream_remote', 'upstream_merge',
  ]);
});

test('SETUP_BASE_PROBE: epoch は optional（required に含まれず properties に number として存在）', () => {
  assert.doesNotMatch(SETUP_BASE_PROBE.required.join(','), /epoch/);
  assert.deepEqual(SETUP_BASE_PROBE.properties.epoch, { type: 'number' });
});

// ── setupBaseProbePrompt: base 解決系（旧 resolveBasePrompt 由来） ──────────────────

test('setupBaseProbePrompt: git ls-remote / --symref / verbatim を含む', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /git ls-remote/);
  assert.match(prompt, /--symref/);
  assert.match(prompt, /verbatim/);
});

test('setupBaseProbePrompt: baseArg 指定時、その値を含む', () => {
  const prompt = setupBaseProbePrompt('release/1.0', 517);
  assert.match(prompt, /release\/1\.0/);
});

test('setupBaseProbePrompt: baseArg null 時、REQ が空文字になる', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /REQ=""/);
});

test('setupBaseProbePrompt: probe パターンが refs/heads/ 前置の完全 ref パス（tail-component match 誤検知対策）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /git ls-remote --exit-code --heads origin "refs\/heads\/dev"/);
  assert.match(prompt, /git ls-remote --exit-code --heads origin "refs\/heads\/\$REQ"/);
});

// ── setupBaseProbePrompt: worktree 起点検証系（旧 worktreeBaseProbePrompt 由来） ─────

test('setupBaseProbePrompt: git worktree list --porcelain を含む（issue #527: パス引数ゼロ構成）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /`git worktree list --porcelain`/);
});

test('setupBaseProbePrompt: git config --get branch. を含む（issue #527: パス引数ゼロ構成）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /`git config --get branch\.<BR>\.remote`/);
  assert.match(prompt, /`git config --get branch\.<BR>\.merge`/);
});

test('setupBaseProbePrompt: git -C の実行コマンドを含まない（worktree-isolation guard 拒否の再発 pin, issue #527）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.doesNotMatch(prompt, /`git -C /);
});

test('setupBaseProbePrompt: test -d の実行コマンドを含まない（worktree-isolation guard 拒否の再発 pin, issue #527）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.doesNotMatch(prompt, /`test -d/);
});

test('setupBaseProbePrompt: @{upstream} を含まない（issue #527: git config --get へ置換）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.doesNotMatch(prompt, /@\{upstream\}/);
});

test('setupBaseProbePrompt: .claude/worktrees/df-517 を含む', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /\.claude\/worktrees\/df-517/);
});

test('setupBaseProbePrompt: repo 外候補 <repo>-wt/df-517 を含む（issue #528: 2候補化）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /-wt\/df-517/);
});

test('setupBaseProbePrompt: WTD_IN が常に先勝ちする旨の文言を含む（issue #528 不変条件）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /先勝ち/);
});

test('setupBaseProbePrompt: prunable 行付きブロックは worktree_exists=false として扱う旨の文言を含む（stale worktree 誤判定 pin, issue #533 review）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /`prunable`/);
  assert.match(prompt, /worktree_exists=false/);
});

// ── setupBaseProbePrompt: epoch 取得（issue #550 F1/F2 — 専用 clock probe 廃止、統合 probe epoch 給電） ──

test('setupBaseProbePrompt: date +%s による epoch 取得コマンドを含む', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /date \+%s/);
});

test('setupBaseProbePrompt: epoch 省略可（fail-open）である旨の文言を含む', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /epoch キーを省略する/);
  assert.match(prompt, /fail-open/);
});

// ── setupBaseProbePrompt: Output format / Tools / Boundary / Token cap ───────────────

test('setupBaseProbePrompt: Output format / Tools / Boundary / Token cap セクションを含む', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /## Output format/);
  assert.match(prompt, /## Tools/);
  assert.match(prompt, /## Boundary/);
  assert.match(prompt, /## Token cap/);
});

test('setupBaseProbePrompt: Output format が両系フィールド（default_branch/dev_exists/requested_exists/worktree_exists/upstream_remote/upstream_merge）を含む1行 JSON 形式である', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(
    prompt,
    /\{"ok":true,"default_branch":"<string>","dev_exists":<bool>,"requested_exists":<bool>,"worktree_exists":<bool>,"upstream_remote":"<string>","upstream_merge":"<string>","epoch":<number, 省略可>\}/,
  );
});

test('setupBaseProbePrompt: Tools セクションが git -C・test を禁止する旨を明示する（issue #527）', () => {
  const prompt = setupBaseProbePrompt(null, 517);
  assert.match(prompt, /`git -C`/);
  assert.match(prompt, /`test`/);
});

// ── resolveBase: 明示指定 ────────────────────────────────────────────────────

test('resolveBase: 明示指定 + 存在 → explicit', () => {
  const res = resolveBase('main', { ok: true, default_branch: 'main', dev_exists: false, requested_exists: true });
  assert.deepEqual(res, { base: 'main', source: 'explicit' });
});

test('resolveBase: 明示指定 + 不在 → throw（message に origin/main を含む）', () => {
  assert.throws(
    () => resolveBase('main', { ok: true, default_branch: 'dev', dev_exists: true, requested_exists: false }),
    /origin\/main/,
  );
});

test('resolveBase: 明示 "dev" + requested_exists:false → throw（silent fallback しない）', () => {
  assert.throws(
    () => resolveBase('dev', { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false }),
    /origin\/dev/,
  );
});

// ── resolveBase: 未指定 ──────────────────────────────────────────────────────

test('resolveBase: 未指定 + dev_exists:true → dev 優先（default_branch が main でも）', () => {
  const res = resolveBase(null, { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false });
  assert.deepEqual(res, { base: 'dev', source: 'origin/dev' });
});

test('resolveBase: 未指定 + dev_exists:false + default_branch:main → origin/HEAD', () => {
  const res = resolveBase(null, { ok: true, default_branch: 'main', dev_exists: false, requested_exists: false });
  assert.deepEqual(res, { base: 'main', source: 'origin/HEAD' });
});

test('resolveBase: 未指定 + dev_exists:false + default_branch 空 → throw', () => {
  assert.throws(
    () => resolveBase(null, { ok: true, default_branch: '', dev_exists: false, requested_exists: false }),
    /dev-flow: base を解決できなかった/,
  );
});

test('resolveBase: default_branch に前後空白 → trim されて返る', () => {
  const res = resolveBase(null, { ok: true, default_branch: '  main  ', dev_exists: false, requested_exists: false });
  assert.deepEqual(res, { base: 'main', source: 'origin/HEAD' });
});

// ── resolveBase: probe 異常系 ────────────────────────────────────────────────

test('resolveBase: probe null → throw', () => {
  assert.throws(() => resolveBase(null, null), /dev-flow: base 解決に失敗/);
});

test('resolveBase: probe.ok:false → throw', () => {
  assert.throws(
    () => resolveBase(null, { ok: false, default_branch: 'main', dev_exists: false, requested_exists: false }),
    /dev-flow: base 解決に失敗/,
  );
});

test('resolveBase: probe が配列 → throw', () => {
  assert.throws(() => resolveBase(null, []), /dev-flow: base 解決に失敗/);
});

test('resolveBase: probe が文字列 → throw', () => {
  assert.throws(() => resolveBase(null, 'not an object'), /dev-flow: base 解決に失敗/);
});

// ── AC ピン: 統合 probe を単一入力として resolveBase / checkWorktreeBase へ渡しても、
// base 解決失敗と worktree 起点不一致が区別可能なエラーで throw すること（issue #550 案1 不変条件） ──

test('[統合 probe] ok:false の同一 probe object → resolveBase が base 解決失敗のエラーで throw する', () => {
  const probe = {
    ok: false, default_branch: '', dev_exists: false, requested_exists: false,
    worktree_exists: false, upstream_remote: '', upstream_merge: '',
  };
  assert.throws(() => resolveBase(null, probe), /base 解決に失敗/);
});

test('[統合 probe] ok:true + base 解決可 + upstream 不一致の同一 probe object → checkWorktreeBase が起点不一致のエラーで throw する', () => {
  const probe = {
    ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
    worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/main',
  };
  // resolveBase 側は正常に解決できる（base 解決失敗ではない）ことを確認した上で、
  // checkWorktreeBase 側が起点不一致で throw することを検証する。
  const resolved = resolveBase(null, probe);
  assert.deepEqual(resolved, { base: 'main', source: 'origin/HEAD' });
  assert.throws(
    () => checkWorktreeBase({ issue: 517, base: 'dev', probe }),
    /起点が一致しない/,
  );
});

test('[統合 probe] base 解決失敗と worktree 起点不一致のエラーメッセージは相異なる', () => {
  const failProbe = {
    ok: false, default_branch: '', dev_exists: false, requested_exists: false,
    worktree_exists: false, upstream_remote: '', upstream_merge: '',
  };
  let resolveBaseMessage = null;
  try {
    resolveBase(null, failProbe);
  } catch (e) {
    resolveBaseMessage = e.message;
  }
  assert.ok(resolveBaseMessage, 'resolveBase が throw しなかった');

  const mismatchProbe = {
    ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
    worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/main',
  };
  let checkWorktreeBaseMessage = null;
  try {
    checkWorktreeBase({ issue: 517, base: 'dev', probe: mismatchProbe });
  } catch (e) {
    checkWorktreeBaseMessage = e.message;
  }
  assert.ok(checkWorktreeBaseMessage, 'checkWorktreeBase が throw しなかった');

  assert.notEqual(resolveBaseMessage, checkWorktreeBaseMessage);
});
