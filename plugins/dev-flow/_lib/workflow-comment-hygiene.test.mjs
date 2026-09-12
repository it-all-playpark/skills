// workflow-comment-hygiene.test.mjs — dev-flow.js / pr-iterate.js の手書き部分コメントから
// 経緯記述（issue 番号・旧仕様の説明・A/B 実測数値）を pin する。
//
// 生成区間（`// ==== BEGIN inline:` 〜 `// ==== END inline:`）は canonical 側で管理され
// 対象外。手書き部分のみを走査する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findHistoryTerms } from './test-helpers/history-terms.mjs';
import { neutralizeRegexLiterals, blankStringLiterals } from './test-helpers/source-scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// 既存 anchor 文字列を hygiene 辞書から除外できない場合の許容リスト。
// 完全一致文字列のみ登録可。0 件が望ましい。
const ALLOWED_ANCHORS = [];

// 対象 src からコメントのみを抽出し、生成区間（inline marker 行含む）は
// 空行に置換してから走査する。
function extractHandwrittenComments(src) {
  const lines = src.split('\n');
  let inInline = false;
  const stripped = lines.map((line) => {
    if (line.trimStart().startsWith('// ==== BEGIN inline:')) {
      inInline = true;
      return '';
    }
    if (line.trimStart().startsWith('// ==== END inline:')) {
      inInline = false;
      return '';
    }
    return inInline ? '' : line;
  });
  const text = blankStringLiterals(neutralizeRegexLiterals(stripped.join('\n')));

  // 前方スキャンで line comment / block comment を検出する。line comment を消費中は
  // 改行までを丸ごとその comment として扱い、途中に現れる `/*`（例: `*.md` のような
  // glob 表記）を block comment の開始と誤認しない（line comment と block comment の
  // regex を独立に走らせると、line comment 内の `/*` から次の実 block comment の `*/`
  // までを誤って一つの block comment として拾ってしまう既知の罠を避ける）。
  const comments = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      const start = i;
      const startLine = line;
      while (i < n && text[i] !== '\n') i++;
      comments.push({ line: startLine, text: text.slice(start, i) });
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      if (i < n) i += 2; // consume closing */
      comments.push({ line: startLine, text: text.slice(start, i) });
      continue;
    }
    i++;
  }

  return comments;
}

function checkFile(relPath) {
  const filePath = join(here, '..', relPath);
  const src = readFileSync(filePath, 'utf8');
  const comments = extractHandwrittenComments(src);

  const violations = [];
  let context7Hits = 0;

  for (const { line, text } of comments) {
    if (ALLOWED_ANCHORS.includes(text.trim())) continue;
    const names = findHistoryTerms(text);
    if (names.length > 0) {
      violations.push(`${relPath}:${line} [${names.join(',')}]: ${text.trim()}`);
    }
    if (/context7/i.test(text)) {
      context7Hits++;
    }
  }

  return { violations, context7Hits };
}

test('dev-flow.js: 手書き部分コメントに経緯記述（issue番号・旧仕様説明・A/B実測）が無い', () => {
  const { violations } = checkFile('.claude/workflows/dev-flow.js');
  assert.equal(violations.length, 0, violations.join('\n'));
});

test('dev-flow.js: 手書き部分コメントに context7 の言及が無い', () => {
  const { context7Hits } = checkFile('.claude/workflows/dev-flow.js');
  assert.equal(context7Hits, 0, 'dev-flow.js の手書きコメントに context7 が残っている');
});

test('pr-iterate.js: 手書き部分コメントに経緯記述（issue番号・旧仕様説明・A/B実測）が無い', () => {
  const { violations } = checkFile('.claude/workflows/pr-iterate.js');
  assert.equal(violations.length, 0, violations.join('\n'));
});

test('pr-iterate.js: 手書き部分コメントに context7 の言及が無い', () => {
  const { context7Hits } = checkFile('.claude/workflows/pr-iterate.js');
  assert.equal(context7Hits, 0, 'pr-iterate.js の手書きコメントに context7 が残っている');
});
