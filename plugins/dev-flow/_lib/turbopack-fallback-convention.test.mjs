// implementer.md / evaluator.md / dev-runner*.md は sandbox write-deny のため、Turbopack fallback
// 規約は dev-flow.js が全 implementer/evaluator/dev-runner spawn prompt に注入する（issue #292）。
//
// 背景: sandbox 内で Next.js の `next build`（Turbopack）が process 生成・ポートバインド制限により
//       TurbopackInternalError (os error 1) で決定的に失敗する既知事象がある。implementer が
//       git stash 等の対照実験を毎回再発明するのを防ぐため、`next build --webpack` 等の非 Turbopack
//       fallback で build 検証してよい旨を規約化する（Next.js 以外のプロジェクトには適用しない）。
//
// このテストは:
//   (1) dev-flow.js に識別子 'TURBOPACK_FALLBACK_CONVENTION' がちょうど 6 回出現する
//       （定義 1 + implPrompt/test-prompt/green-fix/evaluator/fix#i の usage 5）
//   (2) 定数定義の文字列に必要キーワードが全て含まれる
//   (3) 注入位置: implPrompt / Validate phase（test prompt・green-fix prompt）/
//       Evaluate phase（evaluator prompt・fix#i prompt）の各区間に識別子が現れる
//   (4) 定義が inline 生成区間外（最後の END inline マーカーより後）にあること
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

const IDENT = 'TURBOPACK_FALLBACK_CONVENTION';

// ============================================================
// (1) 識別子出現数
// ============================================================

test('[turbopack-fallback] dev-flow.js に TURBOPACK_FALLBACK_CONVENTION がちょうど 6 回出現する', () => {
  const count = src.split(IDENT).length - 1;
  assert.equal(
    count,
    6,
    `dev-flow.js に ${IDENT} が ${count} 回出現（期待: 6 回 = 定義 1 + implPrompt/test-prompt/green-fix/evaluator/fix#i の usage 5）`,
  );
});

// ============================================================
// (2) 定数定義に必要キーワードが含まれる
// ============================================================

test('[turbopack-fallback] 定数定義に必要キーワードが全て含まれる', () => {
  const indices = [];
  let idx = src.indexOf(IDENT);
  while (idx !== -1) {
    indices.push(idx);
    idx = src.indexOf(IDENT, idx + IDENT.length);
  }
  assert.ok(indices.length >= 2, `${IDENT} の出現が定義+利用の最低 2 回に満たない（${indices.length} 回）`);

  // 定義は最初の出現から次（最初の注入）の出現までの区間に閉じているはず
  const defRegion = src.slice(indices[0], indices[1]);

  const requiredKeywords = [
    'TurbopackInternalError',
    'os error 1',
    'next build --webpack',
    'Next.js',
    'Vite',
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

test('[turbopack-fallback] implPrompt〜runImplement 区間に識別子が含まれる（implementer 初回実装 prompt）', () => {
  const region = sliceBetween(src, 'function implPrompt', 'async function runImplement');
  assert.ok(
    region.includes(IDENT),
    `implPrompt 定義区間に ${IDENT} が含まれない`,
  );
});

test('[turbopack-fallback] VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間に識別子が 2 回含まれる（test prompt + green-fix prompt）', () => {
  // issue #320 (F4): test prompt は runValidateLoop と Final reconcile の test#final で共有するため
  // module-scope const VALIDATE_TEST_PROMPT へ抽出済み（WT 確定後・execValidatePhase 定義より前に配置）。
  // そのため識別子の物理的な出現位置は execValidatePhase 関数本体の外（VALIDATE_TEST_PROMPT 定義）+
  // 内（green-fix prompt）の 2 箇所に分かれる。
  const region = sliceBetween(src, 'const VALIDATE_TEST_PROMPT', 'async function execSecurityFloorPhase');
  const count = region.split(IDENT).length - 1;
  assert.equal(
    count,
    2,
    `VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間に ${IDENT} が ${count} 回出現（期待: 2 回 = test prompt(VALIDATE_TEST_PROMPT) + green-fix prompt）`,
  );
});

test('[turbopack-fallback] execEvaluatePhase〜phase(Implement) 区間に識別子が 2 回含まれる（evaluator prompt + fix#i prompt）', () => {
  const region = sliceBetween(src, 'async function execEvaluatePhase', "phase('Implement')");
  const count = region.split(IDENT).length - 1;
  assert.equal(
    count,
    2,
    `execEvaluatePhase 区間に ${IDENT} が ${count} 回出現（期待: 2 回 = evaluator prompt + fix#i prompt）`,
  );
});

// ============================================================
// (4) 定義が inline 生成区間外にあること
// ============================================================

test('[turbopack-fallback] 定数定義が inline 生成区間外（最後の END inline マーカーより後）にある', () => {
  const defIndex = src.indexOf(IDENT);
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
