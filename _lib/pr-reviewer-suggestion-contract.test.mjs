// pr-reviewer-suggestion-contract.test.mjs
// `.claude/agents/pr-reviewer.md` の出力契約に issue #503 AC-2 の object-level 制約
// （suggestion/description はメタレベル指示を含めてはならない）が存在することを source-pin
// するテスト（tdd: テスト先行）。
//
// implementer-guard-blocked-contract.test.mjs の source-pin 形式を踏襲する。対象は
// `.claude/agents/pr-reviewer.md` 本体（agent spawn prompt の一次情報源）。
//
// このテストは以下を assert する:
//   (a) 'object-level' の語が存在する
//   (b) 'メタ' と '指示' と（'含めてはならない' または '禁止'）が制約セクション内に共存する
//   (c) '将来の prompt' または 'prompt の書き方' への言及（禁止対象の明示）が存在する
//   (d) 'incentive-structural' の正当化クラス宣言が存在する
//   (e) 'fix prompt' への埋め込み構造（制約の理由）への言及が存在する

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const prReviewerMdPath = join(here, '..', '.claude/agents/pr-reviewer.md');

const src = readFileSync(prReviewerMdPath, 'utf8');

// object-level 制約セクションを切り出す（見出しから次の見出しまで）。
function extractConstraintSection(text) {
  const startIdx = text.indexOf('object-level 制約');
  assert.ok(startIdx >= 0, 'pr-reviewer.md に object-level 制約セクションの見出しが見つからない');
  const headingLineStart = text.lastIndexOf('\n', startIdx) + 1;
  const rest = text.slice(headingLineStart);
  const nextHeadingIdx = rest.indexOf('\n#', 1);
  return nextHeadingIdx >= 0 ? rest.slice(0, nextHeadingIdx) : rest;
}

const constraintSection = extractConstraintSection(src);

// ============================================================
// (a) 'object-level' の語が存在する
// ============================================================
test('[pr-reviewer-suggestion-contract] pr-reviewer.md に "object-level" が含まれる', () => {
  assert.ok(src.includes('object-level'), 'pr-reviewer.md に "object-level" が存在しない');
});

// ============================================================
// (b) 'メタ' と '指示' と（'含めてはならない' または '禁止'）が制約セクション内に共存する
// ============================================================
test('[pr-reviewer-suggestion-contract] 制約セクションに "メタ" と "指示" と "含めてはならない"/"禁止" が共存する', () => {
  assert.ok(
    constraintSection.includes('メタ'),
    `制約セクションに "メタ" が存在しない:\n${constraintSection.slice(0, 800)}`,
  );
  assert.ok(
    constraintSection.includes('指示'),
    `制約セクションに "指示" が存在しない:\n${constraintSection.slice(0, 800)}`,
  );
  assert.ok(
    constraintSection.includes('含めてはならない') || constraintSection.includes('禁止'),
    `制約セクションに "含めてはならない"/"禁止" が存在しない:\n${constraintSection.slice(0, 800)}`,
  );
});

// ============================================================
// (c) '将来の prompt' または 'prompt の書き方' への言及が存在する
// ============================================================
test('[pr-reviewer-suggestion-contract] 制約セクションに "将来の prompt" または "prompt の書き方" が含まれる', () => {
  assert.ok(
    constraintSection.includes('将来の prompt') || constraintSection.includes('prompt の書き方'),
    `制約セクションに "将来の prompt" / "prompt の書き方" が存在しない:\n${constraintSection.slice(0, 800)}`,
  );
});

// ============================================================
// (d) 'incentive-structural' の正当化クラス宣言が存在する
// ============================================================
test('[pr-reviewer-suggestion-contract] 制約セクションに "incentive-structural" が含まれる', () => {
  assert.ok(
    constraintSection.includes('incentive-structural'),
    `制約セクションに "incentive-structural" が存在しない:\n${constraintSection.slice(0, 800)}`,
  );
});

// ============================================================
// (e) 'fix prompt' への埋め込み構造（制約の理由）への言及が存在する
// ============================================================
test('[pr-reviewer-suggestion-contract] 制約セクションに "fix prompt" が含まれる', () => {
  assert.ok(
    constraintSection.includes('fix prompt'),
    `制約セクションに "fix prompt" が存在しない:\n${constraintSection.slice(0, 800)}`,
  );
});
