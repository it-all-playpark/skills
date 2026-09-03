// _lib/review-confidence-parity.test.mjs
// issue #561: EVAL/REVIEW schema の optional confidence 静的 invariant を pin する。
//
// - AC-1: dev-flow.js の EVAL schema が confidence を宣言する。
// - AC-2: dev-flow.js と pr-iterate.js の REVIEW schema が両方 confidence を宣言する
//   （片方のみの追加を drift として fail させる）。
// - AC-3 前提: REVIEW（両ファイル）/ EVAL の required 配列に 'confidence' が含まれない
//   （StructuredOutput 契約違反 abort を起こさない optional 契約であること）。
// - AC-8: confidence は merge tier / gate policy / goal ledger のいずれの判定入力にもならない
//   （gate 非入力の静的 pin）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

const CONFIDENCE_DECL = "confidence: { type: 'number', minimum: 0, maximum: 1 }";

// `const NAME = {` から次の行頭 `}` までを抽出する（schema object リテラルの粒度で十分。
// ネストした `}` は行頭に来ないためこの単純抽出で schema 全体を捉えられる）。
function extractBlock(src, constName) {
  const startMarker = `const ${constName} = {`;
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx >= 0, `${constName} 宣言が見つからない`);
  const endIdx = src.indexOf('\n}', startIdx);
  assert.ok(endIdx >= 0, `${constName} の終端 '}' が見つからない`);
  return src.slice(startIdx, endIdx);
}

function extractRequiredArray(block, constName) {
  const m = block.match(/required:\s*\[([^\]]*)\]/);
  assert.ok(m, `${constName} の required 配列が見つからない`);
  return m[1];
}

test('[review-confidence-parity] AC-1: dev-flow.js の EVAL schema が optional confidence[0,1] を宣言する', () => {
  const evalBlock = extractBlock(devFlowSrc, 'EVAL');
  assert.ok(
    evalBlock.includes(CONFIDENCE_DECL),
    `EVAL schema に '${CONFIDENCE_DECL}' が含まれていない`,
  );
});

test('[review-confidence-parity] AC-2: dev-flow.js と pr-iterate.js の両方の REVIEW schema が同一の confidence[0,1] を宣言する（片方のみの追加を drift として検出する）', () => {
  const devFlowReviewBlock = extractBlock(devFlowSrc, 'REVIEW');
  const prIterateReviewBlock = extractBlock(prIterateSrc, 'REVIEW');

  assert.ok(
    devFlowReviewBlock.includes(CONFIDENCE_DECL),
    `dev-flow.js の REVIEW schema に '${CONFIDENCE_DECL}' が含まれていない`,
  );
  assert.ok(
    prIterateReviewBlock.includes(CONFIDENCE_DECL),
    `pr-iterate.js の REVIEW schema に '${CONFIDENCE_DECL}' が含まれていない`,
  );
});

test("[review-confidence-parity] AC-3 前提: REVIEW（両ファイル）/ EVAL の required 配列に 'confidence' が含まれない", () => {
  const evalBlock = extractBlock(devFlowSrc, 'EVAL');
  const devFlowReviewBlock = extractBlock(devFlowSrc, 'REVIEW');
  const prIterateReviewBlock = extractBlock(prIterateSrc, 'REVIEW');

  const evalRequired = extractRequiredArray(evalBlock, 'EVAL');
  const devFlowReviewRequired = extractRequiredArray(devFlowReviewBlock, 'dev-flow.js REVIEW');
  const prIterateReviewRequired = extractRequiredArray(prIterateReviewBlock, 'pr-iterate.js REVIEW');

  assert.doesNotMatch(evalRequired, /'confidence'/, 'EVAL の required に confidence が含まれてはならない');
  assert.doesNotMatch(devFlowReviewRequired, /'confidence'/, 'dev-flow.js REVIEW の required に confidence が含まれてはならない');
  assert.doesNotMatch(prIterateReviewRequired, /'confidence'/, 'pr-iterate.js REVIEW の required に confidence が含まれてはならない');
});

test('[review-confidence-parity] AC-8: confidence は merge-tier / gate-policy / goal-ledger の判定入力（gate）に一切出現しない', () => {
  const gateFiles = ['_lib/merge-tier.mjs', '_lib/gate-policy.mjs', '_lib/goal-ledger.mjs'];
  for (const relPath of gateFiles) {
    const src = readFileSync(join(repoRoot, relPath), 'utf8');
    assert.doesNotMatch(
      src,
      /confidence/,
      `${relPath} に 'confidence' トークンが出現している（confidence は記録専用であり gate 判定入力になってはならない）`,
    );
  }
});
