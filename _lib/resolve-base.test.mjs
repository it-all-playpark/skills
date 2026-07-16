import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeBaseArg, resolveBase, resolveBasePrompt, RESOLVE_BASE_PROBE } from './resolve-base.mjs';

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

// ── RESOLVE_BASE_PROBE ──────────────────────────────────────────────────────

test('RESOLVE_BASE_PROBE: required が期待通り', () => {
  assert.deepEqual(RESOLVE_BASE_PROBE.required, ['ok', 'default_branch', 'dev_exists', 'requested_exists']);
});

// ── resolveBasePrompt ───────────────────────────────────────────────────────

test('resolveBasePrompt: git ls-remote / --symref / verbatim を含む', () => {
  const prompt = resolveBasePrompt(null);
  assert.match(prompt, /git ls-remote/);
  assert.match(prompt, /--symref/);
  assert.match(prompt, /verbatim/);
});

test('resolveBasePrompt: baseArg 指定時、その値を含む', () => {
  const prompt = resolveBasePrompt('release/1.0');
  assert.match(prompt, /release\/1\.0/);
});

test('resolveBasePrompt: baseArg null 時、REQ が空文字になる', () => {
  const prompt = resolveBasePrompt(null);
  assert.match(prompt, /REQ=""/);
});

test('resolveBasePrompt: probe パターンが refs/heads/ 前置の完全 ref パス（tail-component match 誤検知対策）', () => {
  const prompt = resolveBasePrompt(null);
  assert.match(prompt, /git ls-remote --exit-code --heads origin "refs\/heads\/dev"/);
  assert.match(prompt, /git ls-remote --exit-code --heads origin "refs\/heads\/\$REQ"/);
});

test('resolveBasePrompt: Output format / Tools / Boundary / Token cap セクションを含む', () => {
  const prompt = resolveBasePrompt(null);
  assert.match(prompt, /## Output format/);
  assert.match(prompt, /## Tools/);
  assert.match(prompt, /## Boundary/);
  assert.match(prompt, /## Token cap/);
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
