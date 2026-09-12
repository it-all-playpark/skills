// implementer.md / evaluator.md / dev-runner*.md は sandbox write-deny のため、Turbopack fallback
// 規約は dev-flow.js が全 implementer/evaluator/dev-runner spawn prompt に注入する。
//
// Turbopack 規約は本文定数 TURBOPACK_FALLBACK_CONVENTION（定義 1 + Setup(stack) 確定用 let 変数
// TURBOPACK_NOTE への代入 1 = 出現 2 回のみ）と、5 箇所の注入先が連結する TURBOPACK_NOTE
// （let 宣言 1 + Setup 代入 1 + 注入 5 = 出現 7 回）に分離されている。注入可否は Setup(stack) が
// worktree-deps 応答の frameworks（detect-stack 相乗り）で決定論的に決め、対象 repo が Next.js の
// ときのみ TURBOPACK_NOTE に本文をセットする。
//
// このテストは:
//   (1) dev-flow.js に識別子 'TURBOPACK_FALLBACK_CONVENTION' がちょうど 2 回、
//       'TURBOPACK_NOTE' がちょうど 7 回出現する
//   (2) 定数定義の文字列に必要キーワードが全て含まれ、LLM に適用可否を判定させる文言（『適用しない』
//       『Vite』）を含まない
//   (3) 注入位置: implPrompt / Validate phase（test prompt・green-fix prompt）/
//       Evaluate phase（evaluator prompt・fix#i prompt）の各区間に TURBOPACK_NOTE が現れ、
//       TURBOPACK_FALLBACK_CONVENTION は現れない
//   (4) 定義が inline 生成区間外（最後の END inline マーカーより後）にあり、
//       Setup 代入が label:'worktree-deps' より後・VALIDATE_TEST_PROMPT 定義より前にあること
//   (5) dev-flow.js に CONTEXT7_BEST_PRACTICE_CONVENTION / context7 の出現が 0 回であること
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

const CONST_IDENT = 'TURBOPACK_FALLBACK_CONVENTION';
const NOTE_IDENT = 'TURBOPACK_NOTE';

// ============================================================
// (1) 識別子出現数
// ============================================================

test('[turbopack-fallback] dev-flow.js に TURBOPACK_FALLBACK_CONVENTION がちょうど 2 回出現する', () => {
  const count = src.split(CONST_IDENT).length - 1;
  assert.equal(
    count,
    2,
    `dev-flow.js に ${CONST_IDENT} が ${count} 回出現（期待: 2 回 = 定義 1 + Setup(stack) 代入 1）`,
  );
});

test('[turbopack-fallback] dev-flow.js に TURBOPACK_NOTE がちょうど 7 回出現する', () => {
  const count = src.split(NOTE_IDENT).length - 1;
  assert.equal(
    count,
    7,
    `dev-flow.js に ${NOTE_IDENT} が ${count} 回出現（期待: 7 回 = let 宣言 1 + Setup 代入 1 + 注入 5）`,
  );
});

// ============================================================
// (2) 定数定義に必要キーワードが含まれ、適用除外文言を含まない
// ============================================================

function constIndices() {
  const indices = [];
  let idx = src.indexOf(CONST_IDENT);
  while (idx !== -1) {
    indices.push(idx);
    idx = src.indexOf(CONST_IDENT, idx + CONST_IDENT.length);
  }
  return indices;
}

test('[turbopack-fallback] 定数定義に必要キーワードが全て含まれ、適用除外文言を含まない', () => {
  const indices = constIndices();
  assert.equal(indices.length, 2, `${CONST_IDENT} の出現が定義+Setup代入の 2 回に一致しない（${indices.length} 回）`);

  // 定義は最初の出現から次（Setup 代入）の出現までの区間に閉じているはず
  const defRegion = src.slice(indices[0], indices[1]);

  const requiredKeywords = [
    'TurbopackInternalError',
    'os error 1',
    'next build --webpack',
    'Next.js',
    '断定',
    '実 CI',
    'コード欠陥',
  ];

  for (const kw of requiredKeywords) {
    assert.ok(
      defRegion.includes(kw),
      `TURBOPACK_FALLBACK_CONVENTION の定義にキーワード "${kw}" が含まれない`,
    );
  }

  assert.ok(!defRegion.includes('適用しない'), '定義に LLM 判定文言「適用しない」が残っている');
  assert.ok(!defRegion.includes('Vite'), '定義に LLM 判定文言中の「Vite」が残っている');
});

// ============================================================
// (3) 注入位置の検証
// ============================================================

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start !== -1, `開始マーカーが見つからない: "${startMarker}"`);
  assert.ok(end !== -1, `終了マーカーが見つからない: "${endMarker}"`);
  assert.ok(start < end, `開始マーカーが終了マーカーより後にある: "${startMarker}" / "${endMarker}"`);
  return source.slice(start, end);
}

function countIn(region, ident) {
  return region.split(ident).length - 1;
}

test('[turbopack-fallback] implPrompt〜runImplement 区間に TURBOPACK_NOTE が 1 回含まれ CONVENTION は含まれない', () => {
  const region = sliceBetween(src, 'function implPrompt', 'async function runImplement');
  assert.equal(countIn(region, NOTE_IDENT), 1, 'implPrompt 定義区間の TURBOPACK_NOTE 出現数が 1 でない');
  assert.equal(countIn(region, CONST_IDENT), 0, 'implPrompt 定義区間に TURBOPACK_FALLBACK_CONVENTION が残っている');
});

test('[turbopack-fallback] VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間に TURBOPACK_NOTE が 2 回含まれ CONVENTION は含まれない', () => {
  const region = sliceBetween(src, 'const VALIDATE_TEST_PROMPT', 'async function execSecurityFloorPhase');
  assert.equal(countIn(region, NOTE_IDENT), 2, 'VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間の TURBOPACK_NOTE 出現数が 2 でない（test prompt + green-fix prompt）');
  assert.equal(countIn(region, CONST_IDENT), 0, 'VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間に TURBOPACK_FALLBACK_CONVENTION が残っている');
});

test('[turbopack-fallback] execEvaluatePhase〜phase(Implement) 区間に TURBOPACK_NOTE が 2 回含まれ CONVENTION は含まれない', () => {
  const region = sliceBetween(src, 'async function execEvaluatePhase', "phase('Implement')");
  assert.equal(countIn(region, NOTE_IDENT), 2, 'execEvaluatePhase 区間の TURBOPACK_NOTE 出現数が 2 でない（evaluator prompt + fix#i prompt）');
  assert.equal(countIn(region, CONST_IDENT), 0, 'execEvaluatePhase 区間に TURBOPACK_FALLBACK_CONVENTION が残っている');
});

// ============================================================
// (4) 定義が inline 生成区間外にあり、Setup 代入の位置が正しいこと
// ============================================================

test('[turbopack-fallback] 定数定義が inline 生成区間外（最後の END inline マーカーより後）にある', () => {
  const defIndex = src.indexOf(CONST_IDENT);
  const endMarker = '// ==== END inline:';
  let lastEndIdx = -1;
  let idx = src.indexOf(endMarker);
  while (idx !== -1) {
    lastEndIdx = idx;
    idx = src.indexOf(endMarker, idx + endMarker.length);
  }
  assert.ok(lastEndIdx !== -1, `dev-flow.js に "${endMarker}" マーカーが見つからない`);
  assert.ok(
    defIndex > lastEndIdx,
    `TURBOPACK_FALLBACK_CONVENTION の定義（index ${defIndex}）が最後の END inline マーカー（index ${lastEndIdx}）より前にある — inline 生成区間内への誤配置の疑い`,
  );
});

test('[turbopack-fallback] Setup(stack) 代入は label:\'worktree-deps\' より後・VALIDATE_TEST_PROMPT 定義より前にある', () => {
  const indices = constIndices();
  const setupAssignIdx = indices[1];
  const worktreeDepsLabelIdx = src.indexOf("label: 'worktree-deps'");
  const validateTestPromptIdx = src.indexOf('const VALIDATE_TEST_PROMPT');
  assert.notEqual(worktreeDepsLabelIdx, -1, "label: 'worktree-deps' が見つからない");
  assert.notEqual(validateTestPromptIdx, -1, 'const VALIDATE_TEST_PROMPT が見つからない');
  assert.ok(setupAssignIdx > worktreeDepsLabelIdx, 'Setup(stack) 代入が label:\'worktree-deps\' より前にある');
  assert.ok(setupAssignIdx < validateTestPromptIdx, 'Setup(stack) 代入が const VALIDATE_TEST_PROMPT より後にある');
});

// ============================================================
// (5) CONTEXT7 が完全に削除されていること
// ============================================================

test('[turbopack-fallback] dev-flow.js に CONTEXT7_BEST_PRACTICE_CONVENTION / context7 の出現が 0 回', () => {
  assert.equal(src.split('CONTEXT7_BEST_PRACTICE_CONVENTION').length - 1, 0, 'CONTEXT7_BEST_PRACTICE_CONVENTION が残っている');
  const context7Count = (src.match(/context7/gi) ?? []).length;
  assert.equal(context7Count, 0, `context7 の出現が ${context7Count} 回残っている（大文字小文字区別なし）`);
});
