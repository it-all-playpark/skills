import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PRERUN_SETUP_REQUIRED,
  PRERUN_MISSING_MSG,
  rejectLegacyBaseArg,
  validatePrerunSetup,
  summarizePrerunDeps,
  hasNextJs,
} from './prerun-setup.mjs';

function validRaw(overrides = {}) {
  return {
    ok: true,
    issue: 641,
    repo: 'it-all-playpark/skills',
    base: 'main',
    base_source: 'default',
    worktree: '/repo/.claude/worktrees/df-641',
    branch: 'feature/issue-641',
    head: 'abc1234',
    worktree_status: 'ok',
    clean: { ok: true },
    deps: { ok: true, note: 'npm:installed' },
    stack: { frameworks: ['next', 'react'] },
    epoch: 1787000000,
    epoch_end: 1787000060,
    ...overrides,
  };
}

// ── validatePrerunSetup: 正常系 ──────────────────────────────────────────────

test('validatePrerunSetup: 正常な setup は各値をそのまま返し frameworks は string のみに絞る', () => {
  const raw = validRaw({ stack: { frameworks: ['next', 42, 'react', null] } });
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.base, 'main');
  assert.equal(result.worktree, '/repo/.claude/worktrees/df-641');
  assert.equal(result.branch, 'feature/issue-641');
  assert.equal(result.head, 'abc1234');
  assert.equal(result.repo, 'it-all-playpark/skills');
  assert.deepEqual(result.deps, { ok: true, note: 'npm:installed' });
  assert.deepEqual(result.frameworks, ['next', 'react']);
  assert.equal(result.epoch, 1787000000);
  assert.equal(result.epoch_end, 1787000060);
});

// ── validatePrerunSetup: raw 自体が欠落/非object/配列 ───────────────────────

for (const [label, raw] of [
  ['undefined', undefined],
  ['null', null],
  ['string', 'str'],
  ['array', []],
]) {
  test(`validatePrerunSetup: raw が ${label} のとき PRERUN_MISSING_MSG で throw`, () => {
    assert.throws(() => validatePrerunSetup(raw, 641), (err) => {
      assert.equal(err.message, PRERUN_MISSING_MSG);
      return true;
    });
  });
}

// ── validatePrerunSetup: ok:false ────────────────────────────────────────────

test('validatePrerunSetup: ok:false のとき base_error/worktree_error/worktree_status を含めて throw する', () => {
  const raw = validRaw({
    ok: false,
    base_error: 'fetch failed',
    worktree_error: 'EPERM: denied',
    worktree_status: 'unwritable',
  });
  assert.throws(() => validatePrerunSetup(raw, 641), (err) => {
    assert.match(err.message, /^dev-flow: args\.setup\.ok が true でない/);
    assert.match(err.message, /base_error: fetch failed/);
    assert.match(err.message, /worktree_error: EPERM: denied/);
    assert.match(err.message, /worktree_status: unwritable/);
    return true;
  });
});

// ── validatePrerunSetup: 必須キーの型 ───────────────────────────────────────

test('validatePrerunSetup: base 欠落は「必須キーが欠落/型不正: base」で throw する', () => {
  const raw = validRaw();
  delete raw.base;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: base/);
});

test('validatePrerunSetup: worktree が相対パスは「必須キーが欠落/型不正: worktree」で throw する', () => {
  const raw = validRaw({ worktree: 'relative/path' });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: worktree/);
});

test('validatePrerunSetup: head が空文字は「必須キーが欠落/型不正: head」で throw する', () => {
  const raw = validRaw({ head: '' });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: head/);
});

test('validatePrerunSetup: deps.ok が非 boolean は「必須キーが欠落/型不正: deps.ok」で throw する', () => {
  const raw = validRaw({ deps: { ok: 'true', note: 'x' } });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: deps\.ok/);
});

test('validatePrerunSetup: deps.note が非 string は「必須キーが欠落/型不正: deps.note」で throw する', () => {
  const raw = validRaw({ deps: { ok: true, note: 123 } });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: deps\.note/);
});

test('validatePrerunSetup: stack.frameworks が非配列は「必須キーが欠落/型不正: stack.frameworks」で throw する', () => {
  const raw = validRaw({ stack: { frameworks: 'next' } });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: stack\.frameworks/);
});

test('validatePrerunSetup: epoch が 0 は「必須キーが欠落/型不正: epoch」で throw する', () => {
  const raw = validRaw({ epoch: 0 });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: epoch/);
});

test('validatePrerunSetup: epoch が非整数(12.5)は「必須キーが欠落/型不正: epoch」で throw する', () => {
  const raw = validRaw({ epoch: 12.5 });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: epoch/);
});

test('validatePrerunSetup: epoch が文字列("1000")は「必須キーが欠落/型不正: epoch」で throw する', () => {
  const raw = validRaw({ epoch: '1000' });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: epoch/);
});

test('validatePrerunSetup: epoch_end が 0 は「必須キーが欠落/型不正: epoch_end」で throw する', () => {
  const raw = validRaw({ epoch_end: 0 });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: epoch_end/);
});

test('validatePrerunSetup: epoch_end 欠落は「必須キーが欠落/型不正: epoch_end」で throw する', () => {
  const raw = validRaw();
  delete raw.epoch_end;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: epoch_end/);
});

test('validatePrerunSetup: epoch_end が非整数(12.5)は「必須キーが欠落/型不正: epoch_end」で throw する', () => {
  const raw = validRaw({ epoch_end: 12.5 });
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: epoch_end/);
});

// ── validatePrerunSetup: issue 一致（stale setup の持ち込み防止） ──────────────

test('validatePrerunSetup: issue 欠落/非整数は必須キー欠落として throw', () => {
  const raw = validRaw();
  delete raw.issue;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: issue/);
  assert.throws(() => validatePrerunSetup(validRaw({ issue: '641' }), 641), /必須キーが欠落\/型不正: issue/);
});

test('validatePrerunSetup: 別 issue の setup は fail-closed で throw（再 prerun を案内）', () => {
  assert.throws(() => validatePrerunSetup(validRaw({ issue: 640 }), 641), /args\.setup\.issue \(640\) が起動 issue \(641\) と一致しない/);
});

test('validatePrerunSetup: 起動 issue が文字列でも数値一致なら受理する', () => {
  assert.doesNotThrow(() => validatePrerunSetup(validRaw(), '641'));
});

// ── validatePrerunSetup: 任意キー ───────────────────────────────────────────

test('validatePrerunSetup: repo 欠落は null を返す', () => {
  const raw = validRaw();
  delete raw.repo;
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.repo, null);
});

test('validatePrerunSetup: branch 欠落は feature/issue-<issue> を返す', () => {
  const raw = validRaw();
  delete raw.branch;
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.branch, 'feature/issue-641');
});

// ── validatePrerunSetup: 未知キー ───────────────────────────────────────────

test('validatePrerunSetup: 未知キーがあっても throw しない', () => {
  const raw = validRaw({ unknown_extra_key: 'anything' });
  assert.doesNotThrow(() => validatePrerunSetup(raw, 641));
});

// ── PRERUN_SETUP_REQUIRED ───────────────────────────────────────────────────

test('PRERUN_SETUP_REQUIRED: 必須キー一覧を定義する', () => {
  assert.deepEqual(PRERUN_SETUP_REQUIRED, ['ok', 'issue', 'base', 'worktree', 'head', 'deps', 'stack', 'epoch', 'epoch_end']);
});

// ── rejectLegacyBaseArg ──────────────────────────────────────────────────────

test('rejectLegacyBaseArg: args.base があると throw する', () => {
  assert.throws(() => rejectLegacyBaseArg({ issue: '1', base: 'dev' }), /args\.base は受理しない/);
});

for (const [label, args] of [
  ['base キーなしの object', { issue: '1' }],
  ['string', '1'],
  ['undefined', undefined],
]) {
  test(`rejectLegacyBaseArg: ${label} は throw しない`, () => {
    assert.doesNotThrow(() => rejectLegacyBaseArg(args));
  });
}

// ── summarizePrerunDeps ──────────────────────────────────────────────────────

test('summarizePrerunDeps: ok:true note空は implNote null, logLine に Setup(deps) を含む', () => {
  const result = summarizePrerunDeps({ ok: true, note: '' });
  assert.equal(result.outcome, 'ok');
  assert.equal(result.implNote, null);
  assert.match(result.logLine, /Setup\(deps\)/);
});

test('summarizePrerunDeps: ok:true note非空は logLine に note を含む', () => {
  const result = summarizePrerunDeps({ ok: true, note: 'npm:installed' });
  assert.match(result.logLine, /npm:installed/);
});

test('summarizePrerunDeps: ok:false は implNote が「依存インストール警告」で始まり note を含み、logLine が「⚠️」で始まり「（fail-open で続行）」を含む', () => {
  const note = '依存インストールが failed で終了 — npm/npm (npm ci): failed';
  const result = summarizePrerunDeps({ ok: false, note });
  assert.match(result.implNote, /^依存インストール警告/);
  assert.ok(result.implNote.includes(note));
  assert.match(result.logLine, /^⚠️/);
  assert.match(result.logLine, /（fail-open で続行）/);
});

test('summarizePrerunDeps: ok:false かつ note 空でも implNote は非 null', () => {
  const result = summarizePrerunDeps({ ok: false, note: '' });
  assert.notEqual(result.implNote, null);
});

// ── hasNextJs ────────────────────────────────────────────────────────────────

test('hasNextJs: next を含む配列は true', () => {
  assert.equal(hasNextJs(['next']), true);
});

test('hasNextJs: next を含まない配列は false', () => {
  assert.equal(hasNextJs(['react']), false);
});

test('hasNextJs: 空配列は false', () => {
  assert.equal(hasNextJs([]), false);
});

test('hasNextJs: undefined は false', () => {
  assert.equal(hasNextJs(undefined), false);
});

// ── 静的検査: inline 制約（ESM import / require / Date.now / Math.random を含まない） ──

test('prerun-setup.mjs: import / require / Date.now / Math.random を含まない', () => {
  const path = fileURLToPath(new URL('./prerun-setup.mjs', import.meta.url));
  const code = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /\bimport\s/);
  assert.doesNotMatch(code, /\brequire\(/);
  assert.doesNotMatch(code, /Date\.now/);
  assert.doesNotMatch(code, /Math\.random/);
});
