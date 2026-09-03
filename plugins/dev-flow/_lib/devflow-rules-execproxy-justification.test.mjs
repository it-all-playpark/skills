// devflow-rules-execproxy-justification.test.mjs
// `.claude/rules/dev-flow.md` の exec-proxy 規範（「prompt に sandbox / excludedCommands /
// 特定パス起動の理由を書いてはならない」）の正当化を、外形的理由（「分類器に検知されるから」）
// から実体的理由（exec-proxy prompt は決定論スクリプトへの verbatim 転写契約であり、起動形の
// 正しさは excludedCommands という設定側の不変条件であること）へ書き換えたことを source-pin する
// 静的テスト（tdd: テスト先行。issue #503 AC-1）。
//
// implementer-guard-blocked-contract.test.mjs の source-pin 方式を踏襲する。
//
// このテストは以下を assert する:
//   (a) '（分類器 trigger）' がファイル全体に存在しない
//   (b) 対象段落（'理由を書いてはならない' を含む blockquote 段落）に '分類器' が存在しない
//   (c) 同段落に規範文本体（'sandbox / excludedCommands / 特定パス起動の理由を書いてはならない'
//       と '**例外はない**'）が引き続き存在する（規範自体の緩和ではないことを pin）
//   (d) 同段落に実体的正当化のアンカー語（'verbatim 転写' / '設定' / '一箇所'）が存在する
//
// 注意: ファイル内の行98・121 付近にある英語の 'safety classifier block'（guard_blocked enum の
// 記述的列挙）は正当化ではないため、(a)(b) は段落単位のスコープに限定し、ファイル全体から
// 'classifier' を禁止してはならない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const rulesPath = join(REPO_ROOT, '.claude/rules/dev-flow.md');

const src = readFileSync(rulesPath, 'utf8');

// 対象段落（blockquote）を切り出す: 開始アンカーから、次の空 blockquote 行（"\n>\n"）まで。
// 開始アンカー・終了境界はいずれも本 task で変更しない部分の固定文字列なので、書き換え後も
// 安定して切り出せる。
function extractExecProxyJustificationParagraph(text) {
  const startAnchor = '> exec-proxy スクリプトは認証付き network I/O';
  const startIdx = text.indexOf(startAnchor);
  assert.ok(
    startIdx >= 0,
    'dev-flow.md に exec-proxy スクリプトの network I/O 制約段落の開始アンカーが見つからない',
  );
  const blankBlockquoteSep = '\n>\n';
  const endIdx = text.indexOf(blankBlockquoteSep, startIdx);
  assert.ok(endIdx >= 0, '対象段落の終端（空 blockquote 行）が見つからない');
  return text.slice(startIdx, endIdx);
}

const paragraph = extractExecProxyJustificationParagraph(src);

// ============================================================
// (a) '（分類器 trigger）' がファイル全体に存在しない
// ============================================================
test('[execproxy-justification] dev-flow.md 全体に "（分類器 trigger）" が存在しない', () => {
  assert.ok(
    !src.includes('（分類器 trigger）'),
    'dev-flow.md に外形的正当化 "（分類器 trigger）" が残存している',
  );
});

// ============================================================
// (b) 対象段落に '分類器' が存在しない
// ============================================================
test('[execproxy-justification] 対象段落に "分類器" が存在しない', () => {
  assert.ok(
    !paragraph.includes('分類器'),
    `対象段落に "分類器" が残存している:\n${paragraph}`,
  );
});

// ============================================================
// (c) 規範文本体と「例外はない」は維持されている
// ============================================================
test('[execproxy-justification] 対象段落に規範文本体が存在する', () => {
  assert.ok(
    paragraph.includes('sandbox / excludedCommands / 特定パス起動の理由を書いてはならない'),
    `対象段落に規範文本体が存在しない:\n${paragraph}`,
  );
});

test('[execproxy-justification] 対象段落に "**例外はない**" が存在する', () => {
  assert.ok(
    paragraph.includes('**例外はない**'),
    `対象段落に "**例外はない**" が存在しない:\n${paragraph}`,
  );
});

// ============================================================
// (d) 実体的正当化のアンカー語が存在する
// ============================================================
test('[execproxy-justification] 対象段落に実体的正当化のアンカー語 "verbatim 転写" が存在する', () => {
  assert.ok(
    paragraph.includes('verbatim 転写'),
    `対象段落に "verbatim 転写" が存在しない:\n${paragraph}`,
  );
});

test('[execproxy-justification] 対象段落に実体的正当化のアンカー語 "設定" が存在する', () => {
  assert.ok(
    paragraph.includes('設定'),
    `対象段落に "設定" が存在しない:\n${paragraph}`,
  );
});

test('[execproxy-justification] 対象段落に実体的正当化のアンカー語 "一箇所" が存在する', () => {
  assert.ok(
    paragraph.includes('一箇所'),
    `対象段落に "一箇所" が存在しない:\n${paragraph}`,
  );
});

// ============================================================
// W7 表: incentive-structural 行に review-finding 決定論スクラバーが追記されている
// ============================================================
test('[execproxy-justification] W7 incentive-structural 行に review-finding 決定論スクラバーが存在する', () => {
  assert.ok(
    src.includes('review-finding 決定論スクラバー'),
    'W7 incentive-structural 表の代表機構列に "review-finding 決定論スクラバー" が存在しない',
  );
});

test('[execproxy-justification] review-finding 決定論スクラバーの記述が issue #503 を参照する', () => {
  const idx = src.indexOf('review-finding 決定論スクラバー');
  assert.ok(idx >= 0, 'review-finding 決定論スクラバーの記述が見つからない');
  const nearby = src.slice(idx, idx + 300);
  assert.ok(
    nearby.includes('issue #503'),
    `review-finding 決定論スクラバーの記述に issue #503 の参照が存在しない:\n${nearby}`,
  );
});
