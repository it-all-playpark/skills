// implementer-guard-blocked-contract.test.mjs
// `.claude/agents/dev-implement-fable.md` の guard_blocked 契約（issue #448 / #451 由来。#673 で
// implementer.md から dev-implement-fable.md へ移設）を source-pin するテスト。
//
// implementer-staging-convention.test.mjs の Part 1（source pin）形式を踏襲するが、対象は
// dev-flow.js ではなく `.claude/agents/dev-implement-fable.md` 本体（agent spawn prompt の一次情報源）。
//
// このテストは以下を assert する:
//   (a) 'guard_blocked' と 'block_class' が存在する
//   (b) 'sandbox EPERM' / 'bg-isolation' / 'hook' が guard_blocked の定義文脈に存在する
//   (c) 「sanctioned path（正規経路）が存在しない壁では迂回せず guard_blocked で終端する」契約が
//       'sanctioned path' または '正規経路' の語で存在する
//   (d) git plumbing 迂回の明示禁止: 'hash-object' と 'update-index' と 'checkout-index' が存在する
//       （PR #452 で実測された迂回手段）
//   (e) '迂回' + '禁止'（または 'してはならない'）が存在する
//   (f) JSON 例に '"block_class": "guard_blocked"' が存在する

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const agentMdPath = join(here, '..', '.claude/agents/dev-implement-fable.md');

const src = readFileSync(agentMdPath, 'utf8');

// guard_blocked の定義文脈を切り出す（bullet 見出しから次の見出しまで）。
function extractGuardBlockedSection(text) {
  const startIdx = text.indexOf('**`guard_blocked`**');
  assert.ok(startIdx >= 0, 'dev-implement-fable.md に guard_blocked bullet の見出しが見つからない');
  const rest = text.slice(startIdx);
  const nextHeadingIdx = rest.search(/\n##+ /);
  return nextHeadingIdx >= 0 ? rest.slice(0, nextHeadingIdx) : rest;
}

const guardSection = extractGuardBlockedSection(src);

// ============================================================
// (a) 'guard_blocked' と 'block_class' が存在する
// ============================================================
test('[guard-blocked-contract] dev-implement-fable.md に "guard_blocked" が含まれる', () => {
  assert.ok(src.includes('guard_blocked'), 'dev-implement-fable.md に "guard_blocked" が存在しない');
});

test('[guard-blocked-contract] dev-implement-fable.md に "block_class" が含まれる', () => {
  assert.ok(src.includes('block_class'), 'dev-implement-fable.md に "block_class" が存在しない');
});

// ============================================================
// (b) 'sandbox EPERM' / 'bg-isolation' / 'hook' が guard_blocked 定義文脈に存在する
// ============================================================
for (const token of ['sandbox EPERM', 'bg-isolation', 'hook']) {
  test(`[guard-blocked-contract] guard_blocked 定義文脈に "${token}" が含まれる`, () => {
    assert.ok(guardSection.includes(token), `guard_blocked 定義文脈に "${token}" が存在しない:\n${guardSection.slice(0, 500)}`);
  });
}

// ============================================================
// (c) sanctioned path（正規経路）が存在しない壁では迂回せず guard_blocked で終端する契約
// ============================================================
test('[guard-blocked-contract] guard_blocked 定義文脈に "sanctioned path" または "正規経路" が含まれる', () => {
  assert.ok(
    guardSection.includes('sanctioned path') || guardSection.includes('正規経路'),
    `guard_blocked 定義文脈に "sanctioned path" / "正規経路" が存在しない:\n${guardSection.slice(0, 800)}`,
  );
});

// ============================================================
// (d) git plumbing 迂回の明示禁止（PR #452 実測）
// ============================================================
for (const token of ['hash-object', 'update-index', 'checkout-index']) {
  test(`[guard-blocked-contract] guard_blocked 定義文脈に "${token}" が含まれる`, () => {
    assert.ok(guardSection.includes(token), `guard_blocked 定義文脈に "${token}" が存在しない:\n${guardSection.slice(0, 800)}`);
  });
}

// ============================================================
// (e) '迂回' + '禁止'（または 'してはならない'）
// ============================================================
test('[guard-blocked-contract] guard_blocked 定義文脈に "迂回" と "禁止"/"してはならない" が含まれる', () => {
  assert.ok(guardSection.includes('迂回'), `guard_blocked 定義文脈に "迂回" が存在しない:\n${guardSection.slice(0, 800)}`);
  assert.ok(
    guardSection.includes('禁止') || guardSection.includes('してはならない'),
    `guard_blocked 定義文脈に "禁止" / "してはならない" が存在しない:\n${guardSection.slice(0, 800)}`,
  );
});

// ============================================================
// (f) JSON 例に '"block_class": "guard_blocked"' が存在する
// ============================================================
test('[guard-blocked-contract] dev-implement-fable.md の JSON 例に \'"block_class": "guard_blocked"\' が含まれる', () => {
  assert.ok(
    src.includes('"block_class": "guard_blocked"'),
    'dev-implement-fable.md の JSON 例に \'"block_class": "guard_blocked"\' が存在しない',
  );
});
