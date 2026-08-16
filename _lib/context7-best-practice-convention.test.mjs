// implementer.md は sandbox write-deny かつ本 issue の AC で編集禁止のため、framework best-practice
// 参照規約（vendored SKILL.md 読み込みから条件付き context7 参照への置換。issue #497）は
// TURBOPACK_FALLBACK_CONVENTION と同型で dev-flow.js が implementer spawn prompt に注入する。
//
// このテストは:
//   (1) dev-flow.js に識別子 'CONTEXT7_BEST_PRACTICE_CONVENTION' がちょうど 4 回出現する
//       （定義 1 + implPrompt/green-fix#i/fix#i の usage 3）
//   (2) 定数定義の文字列に必要キーワードが全て含まれる
//   (3) 注入位置: implPrompt 区間に 1 回、Validate phase（green-fix prompt のみ）に 1 回、
//       Evaluate phase（fix#i prompt のみ）に 1 回（test prompt / evaluator prompt には注入しない）
//   (4) 定義が inline 生成区間外（最後の END inline マーカーより後）にあること
// を assert する。
//
// test-prompt（dev-runner）と evaluator prompt には注入しない — implementer ではなく、evaluator が
// 判定するのは diff であって docs ではないため（TURBOPACK_FALLBACK_CONVENTION とは注入箇所数が異なる）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

const IDENT = 'CONTEXT7_BEST_PRACTICE_CONVENTION';

// ============================================================
// (1) 識別子出現数
// ============================================================

test('[context7-best-practice] dev-flow.js に CONTEXT7_BEST_PRACTICE_CONVENTION がちょうど 4 回出現する', () => {
  const count = src.split(IDENT).length - 1;
  assert.equal(
    count,
    4,
    `dev-flow.js に ${IDENT} が ${count} 回出現（期待: 4 回 = 定義 1 + implPrompt/green-fix#i/fix#i の usage 3）`,
  );
});

// ============================================================
// (2) 定数定義に必要キーワードが含まれる
// ============================================================

test('[context7-best-practice] 定数定義に必要キーワードが全て含まれる', () => {
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
    'detect-stack.sh',
    'frameworks',
    'context7',
    'fail-open',
    'bare 形',
    '無条件に発動しない',
  ];

  for (const kw of requiredKeywords) {
    assert.ok(
      defRegion.includes(kw),
      `CONTEXT7_BEST_PRACTICE_CONVENTION の定義にキーワード "${kw}" が含まれない`,
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

test('[context7-best-practice] implPrompt〜runImplement 区間に識別子が 1 回含まれる（implementer 初回実装 prompt）', () => {
  const region = sliceBetween(src, 'function implPrompt', 'async function runImplement');
  const count = region.split(IDENT).length - 1;
  assert.equal(
    count,
    1,
    `implPrompt 定義区間に ${IDENT} が ${count} 回出現（期待: 1 回）`,
  );
});

test('[context7-best-practice] VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間に識別子が 1 回含まれる（green-fix prompt のみ。test prompt には注入しない）', () => {
  const region = sliceBetween(src, 'const VALIDATE_TEST_PROMPT', 'async function execSecurityFloorPhase');
  const count = region.split(IDENT).length - 1;
  assert.equal(
    count,
    1,
    `VALIDATE_TEST_PROMPT〜execSecurityFloorPhase 区間に ${IDENT} が ${count} 回出現（期待: 1 回 = green-fix prompt のみ）`,
  );
});

test('[context7-best-practice] execEvaluatePhase〜phase(Implement) 区間に識別子が 1 回含まれる（fix#i prompt のみ。evaluator prompt には注入しない）', () => {
  const region = sliceBetween(src, 'async function execEvaluatePhase', "phase('Implement')");
  const count = region.split(IDENT).length - 1;
  assert.equal(
    count,
    1,
    `execEvaluatePhase 区間に ${IDENT} が ${count} 回出現（期待: 1 回 = fix#i prompt のみ）`,
  );
});

// ============================================================
// (4) 定義が inline 生成区間外にあること
// ============================================================

test('[context7-best-practice] 定数定義が inline 生成区間外（最後の END inline マーカーより後）にある', () => {
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
    `CONTEXT7_BEST_PRACTICE_CONVENTION の定義（index ${defIndex}）が最後の END inline マーカー（index ${lastEndIdx}）より前にある — inline 生成区間内への誤配置の疑い`,
  );
});
