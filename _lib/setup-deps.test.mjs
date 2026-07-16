import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setupDepsPrompt, summarizeDepsResult } from './setup-deps.mjs';

// ── setupDepsPrompt ─────────────────────────────────────────────────────────

test('setupDepsPrompt: worktree パス・スクリプト名・フラグ・verbatim 指示を含む', () => {
  const prompt = setupDepsPrompt('/path/to/worktree');
  assert.match(prompt, /\/path\/to\/worktree/);
  assert.match(prompt, /ensure-worktree-deps\.sh/);
  assert.match(prompt, /--lockfile-only/);
  assert.match(prompt, /--skip-custom/);
  assert.match(prompt, /verbatim/);
  assert.match(prompt, /~\/\.claude\/skills\//);
});

test('setupDepsPrompt: cd で worktree に移動する指示を含む', () => {
  const prompt = setupDepsPrompt('/some/wt');
  assert.match(prompt, /cd \/some\/wt/);
});

// ── summarizeDepsResult ─────────────────────────────────────────────────────

test('summarizeDepsResult: null → unverified + implNote 非 null', () => {
  const res = summarizeDepsResult(null);
  assert.equal(res.outcome, 'unverified');
  assert.equal(typeof res.logLine, 'string');
  assert.ok(res.logLine.length > 0);
  assert.notEqual(res.implNote, null);
});

test('summarizeDepsResult: object でない値 → unverified', () => {
  const res = summarizeDepsResult('not an object');
  assert.equal(res.outcome, 'unverified');
  assert.notEqual(res.implNote, null);
});

test('summarizeDepsResult: status が enum 外 → unverified (bogus)', () => {
  const res = summarizeDepsResult({ status: 'bogus' });
  assert.equal(res.outcome, 'unverified');
  assert.notEqual(res.implNote, null);
});

test('summarizeDepsResult: no_dependencies → implNote null', () => {
  const res = summarizeDepsResult({ status: 'no_dependencies' });
  assert.equal(res.outcome, 'no_dependencies');
  assert.equal(res.implNote, null);
  assert.match(res.logLine, /lockfile なし/);
});

test('summarizeDepsResult: success + all installed → installed, implNote null', () => {
  const res = summarizeDepsResult({
    status: 'success',
    results: [{ ecosystem: 'node', pm: 'npm', status: 'installed', command: 'npm ci' }],
  });
  assert.equal(res.outcome, 'installed');
  assert.equal(res.implNote, null);
  assert.match(res.logLine, /npm/);
});

test('summarizeDepsResult: success + already_installed/dry_run mix → installed', () => {
  const res = summarizeDepsResult({
    status: 'success',
    results: [
      { ecosystem: 'node', pm: 'npm', status: 'already_installed', command: 'npm ci' },
      { ecosystem: 'python', pm: 'pip', status: 'dry_run', command: 'pip install' },
    ],
  });
  assert.equal(res.outcome, 'installed');
  assert.equal(res.implNote, null);
});

test('summarizeDepsResult: success + pm_not_found in results → failed + implNote 非 null', () => {
  const res = summarizeDepsResult({
    status: 'success',
    results: [{ ecosystem: 'node', pm: 'pnpm', status: 'pm_not_found', command: 'pnpm install' }],
  });
  assert.equal(res.outcome, 'failed');
  assert.notEqual(res.implNote, null);
  assert.match(res.implNote, /pnpm/);
});

test('summarizeDepsResult: success + failed in results → failed', () => {
  const res = summarizeDepsResult({
    status: 'success',
    results: [{ ecosystem: 'node', pm: 'npm', status: 'failed', command: 'npm ci' }],
  });
  assert.equal(res.outcome, 'failed');
  assert.notEqual(res.implNote, null);
});

test('summarizeDepsResult: success without results field → treated as [] → installed', () => {
  const res = summarizeDepsResult({ status: 'success' });
  assert.equal(res.outcome, 'installed');
  assert.equal(res.implNote, null);
});

test('summarizeDepsResult: partial → failed + implNote に command を含む', () => {
  const res = summarizeDepsResult({
    status: 'partial',
    results: [{ ecosystem: 'node', pm: 'npm', status: 'failed', command: 'npm ci' }],
  });
  assert.equal(res.outcome, 'failed');
  assert.notEqual(res.implNote, null);
  assert.match(res.implNote, /npm ci/);
});

test('summarizeDepsResult: failed + error フィールド → implNote に error 内容を含む', () => {
  const res = summarizeDepsResult({ status: 'failed', error: 'path does not exist' });
  assert.equal(res.outcome, 'failed');
  assert.notEqual(res.implNote, null);
  assert.match(res.implNote, /path does not exist/);
});

test('summarizeDepsResult: implNote 非 null の全ケースで文字列が "依存インストール警告" で始まる', () => {
  const cases = [
    null,
    { status: 'bogus' },
    { status: 'success', results: [{ ecosystem: 'node', pm: 'pnpm', status: 'pm_not_found', command: 'pnpm install' }] },
    { status: 'partial', results: [{ ecosystem: 'node', pm: 'npm', status: 'failed', command: 'npm ci' }] },
    { status: 'failed', error: 'x' },
  ];
  for (const c of cases) {
    const res = summarizeDepsResult(c);
    assert.notEqual(res.implNote, null);
    assert.ok(res.implNote.startsWith('依存インストール警告'), `implNote should start with 依存インストール警告: ${res.implNote}`);
  }
});
