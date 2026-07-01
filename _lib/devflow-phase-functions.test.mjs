// TDD guard test（issue #256）: dev-flow.js の Implement 以降 phase orchestration を
// 暗黙クロージャ共有(約20個の top-level mutable binding + implPrompt の req/plan 前方参照)から
// 単一 state オブジェクトを引数/返り値で明示的に受け渡す exec*Phase 関数群へ抽出する refactor の
// 構造 AC を RED で pin する。
//
// F2(phase 関数抽出)まで (1)(2) は RED。behavior 保存は既存 40+ VM/routing テスト側で担保し
// 本 test は構造 pin のみ。
//
// パターン: _lib/devflow-meta-phases.test.mjs と同スタイル（readFileSync + regex + node:test、
// VM sandbox は使わない source-string only）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const devFlowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- (1) [AC#1] implPrompt が req/plan を明示 param で受ける ----

test('[AC#1] implPrompt が req と plan を明示 param として受け取る（暗黙クロージャ参照ではない）', () => {
  const match = src.match(/function implPrompt\s*\(([^)]*)\)/);
  assert.ok(match, 'implPrompt 関数宣言が見つからない');

  const params = match[1];
  assert.ok(params.includes('req'), `implPrompt の param リストに req が含まれない: ${params}`);
  assert.ok(params.includes('plan'), `implPrompt の param リストに plan が含まれない: ${params}`);
});

// ---- (2) [AC#2] 4 phase 関数の宣言と state 引数付き呼び出しが存在 ----

test('[AC#2] execImplementPhase / execValidatePhase / execSecurityFloorPhase / execEvaluatePhase が宣言され、state 引数付きで呼び出される', () => {
  const phaseFnNames = [
    'execImplementPhase',
    'execValidatePhase',
    'execSecurityFloorPhase',
    'execEvaluatePhase',
  ];

  for (const name of phaseFnNames) {
    const declMatches = src.match(new RegExp(`async function ${name}\\b`, 'g'));
    assert.ok(declMatches && declMatches.length >= 1, `async function ${name} の宣言が見つからない`);

    const callMatches = src.match(new RegExp(`state\\s*=\\s*await ${name}\\(state\\)`, 'g'));
    assert.ok(
      callMatches && callMatches.length >= 1,
      `state = await ${name}(state) 形式の呼び出しが見つからない`,
    );
  }
});

// ---- (3) [regression 防御] phase('Implement'/'Validate'/'Security floor'/'Evaluate') が行頭アンカーで存在 ----

test('[regression] phase(...) 呼び出しが Implement/Validate/Security floor/Evaluate それぞれ行頭アンカーで存在する', () => {
  const phaseNames = ['Implement', 'Validate', 'Security floor', 'Evaluate'];
  for (const name of phaseNames) {
    const re = new RegExp(`^phase\\('${name}'\\)`, 'm');
    assert.ok(re.test(src), `phase('${name}') が行頭アンカーで見つからない`);
  }
});

// ---- (4) [regression 防御] runImplement 窓 anchor の健全性 ----

test('[regression] async function runImplement の窓 anchor が保たれている（runImplementPhase 等の接頭辞衝突が無い）', () => {
  const idx = src.indexOf('async function runImplement');
  assert.notStrictEqual(idx, -1, 'async function runImplement が見つからない');

  const afterIdx = src.slice(idx);
  assert.match(
    afterIdx,
    /^async function runImplement\s*\(/,
    'async function runImplement の直後が helper 本体（引数リスト開始）になっていない',
  );

  assert.doesNotMatch(
    src,
    /async function runImplement[A-Za-z]/,
    'runImplement に接頭辞衝突する関数名（例: runImplementPhase）が存在する',
  );
});

// ---- (5) [regression 防御] runValidateLoop 名保持 + STAGING_CONVENTION 出現数維持 ----

test('[regression] runValidateLoop の関数名が保持され、STAGING_CONVENTION の出現数が 4 回のまま維持される', () => {
  const runValidateLoopMatches = src.match(/function runValidateLoop/g);
  assert.ok(runValidateLoopMatches && runValidateLoopMatches.length >= 1, 'function runValidateLoop が見つからない');

  const stagingConventionMatches = src.match(/STAGING_CONVENTION/g);
  assert.ok(stagingConventionMatches, 'STAGING_CONVENTION が見つからない');
  assert.strictEqual(
    stagingConventionMatches.length,
    4,
    `STAGING_CONVENTION の出現数が 4 でない。実際: ${stagingConventionMatches.length}`,
  );
});
