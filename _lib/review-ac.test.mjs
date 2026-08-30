// _lib/review-ac.mjs（pr-reviewer への AC 注入ブロック）の単体テスト + 両経路の配線 pin。
//
// 守っている不変条件:
//   - AC が取得できない経路（単体起動の /pr-iterate）では空文字を返し、prompt が従来どおりになる
//     （fail-open。AC 取得のために gh 呼び出しを増やさない設計）
//   - pr-iterate（review#i）と dev-flow lite route（pr-review-lite）の**両方**が注入する
//     （片側だけだと 2 経路で reviewer の見るものが食い違う）
//   - ゲート境界を変えない: 本 issue は pr-reviewer への入力追加のみで、AC 未達の blocking 判定は
//     既存の merge tier HOLD が担う。prompt が severity 引き上げを指示していないことを pin する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acceptanceCriteriaBlock } from './review-ac.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

// ============================================================
// fail-open: AC が無い経路では注入しない
// ============================================================

test('[review-ac] undefined は空文字（単体起動の /pr-iterate 経路）', () => {
  assert.equal(acceptanceCriteriaBlock(undefined), '');
});

test('[review-ac] null / 非配列は空文字', () => {
  assert.equal(acceptanceCriteriaBlock(null), '');
  assert.equal(acceptanceCriteriaBlock('AC1'), '');
  assert.equal(acceptanceCriteriaBlock({ 0: 'AC1' }), '');
});

test('[review-ac] 空配列は空文字', () => {
  assert.equal(acceptanceCriteriaBlock([]), '');
});

test('[review-ac] 空白のみ / 非文字列だけの配列は空文字', () => {
  assert.equal(acceptanceCriteriaBlock(['', '   ', '\n']), '');
  assert.equal(acceptanceCriteriaBlock([null, 42, {}]), '');
});

// ============================================================
// 注入内容
// ============================================================

test('[review-ac] AC を 1 始まりで番号付けする', () => {
  const block = acceptanceCriteriaBlock(['first', 'second']);
  assert.ok(block.includes('1. first'), block);
  assert.ok(block.includes('2. second'), block);
});

test('[review-ac] 非文字列・空要素は除外したうえで採番し直す', () => {
  const block = acceptanceCriteriaBlock(['first', '', null, 'second']);
  assert.ok(block.includes('1. first'), block);
  assert.ok(block.includes('2. second'), block);
  assert.ok(!block.includes('3.'), '除外した要素の分だけ番号が飛んではならない');
});

test('[review-ac] 各要素は trim される', () => {
  assert.ok(acceptanceCriteriaBlock(['  padded  ']).includes('1. padded'));
});

test('[review-ac] 決定論的（同入力 -> 同出力）', () => {
  const input = ['a', 'b'];
  assert.equal(acceptanceCriteriaBlock(input), acceptanceCriteriaBlock(input));
});

test('[review-ac] 末尾は改行で終わる（後続 prompt と結合しても崩れない）', () => {
  assert.ok(acceptanceCriteriaBlock(['a']).endsWith('\n'));
});

// ============================================================
// ゲート境界: severity の引き上げを指示しない
// ============================================================

test('[review-ac] AC 未達を理由に critical へ引き上げないことを prompt で明示する', () => {
  const block = acceptanceCriteriaBlock(['a']);
  assert.ok(
    block.includes('critical へ引き上げない'),
    'AC 未達だけを理由に severity を上げない旨が prompt に含まれるべき（ゲート境界を変えない）',
  );
});

// ============================================================
// 配線 pin: 両経路が注入している
// ============================================================

test('[review-ac] pr-iterate の review prompt が acceptanceCriteriaBlock を注入する', () => {
  const m = prIterateSrc.match(/const reviewPrompt = ([\s\S]*?)\n  const review = await callReviewAgent/);
  assert.ok(m, 'reviewPrompt の組み立てブロックが見つかるべき');
  assert.ok(
    m[1].includes('acceptanceCriteriaBlock('),
    'pr-iterate の reviewPrompt は acceptanceCriteriaBlock() を注入すべき',
  );
});

test('[review-ac] pr-iterate は acceptance_criteria を workflow args から受け取る', () => {
  assert.ok(
    /const ACCEPTANCE_CRITERIA = args\?\.acceptance_criteria/.test(prIterateSrc),
    'pr-iterate は args.acceptance_criteria を読むべき',
  );
});

test('[review-ac] dev-flow lite route の reviewPromptLite が acceptanceCriteriaBlock を注入する', () => {
  const m = devFlowSrc.match(/const reviewPromptLite = ([\s\S]*?)\n  const reviewLite = await trackedAgent/);
  assert.ok(m, 'reviewPromptLite の組み立てブロックが見つかるべき');
  assert.ok(
    m[1].includes('acceptanceCriteriaBlock('),
    'dev-flow lite route の reviewPromptLite は acceptanceCriteriaBlock() を注入すべき',
  );
});

test('[review-ac] dev-flow の nested pr-iterate 起動 3 箇所すべてが acceptance_criteria を渡す', () => {
  const launches = devFlowSrc.match(/workflow\('pr-iterate', \{[^}]*\}\)/g) ?? [];
  assert.equal(launches.length, 3, `nested 起動は 3 箇所のはずだが ${launches.length} 箇所だった`);
  for (const l of launches) {
    assert.ok(
      l.includes('acceptance_criteria:'),
      `nested 起動が acceptance_criteria を渡していない: ${l}`,
    );
  }
});
