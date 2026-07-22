// issue #409 (#390 Phase 1) 非干渉 guard → issue #410 (#390 Phase 2) 配線 routing test に置換。
//
// Phase 1 時点では「配線ゼロ」を固定するテストだったが、本 PR（Phase 2）で dev-flow.js の
// Analyze phase へ SurfaceProof adapter の shadow call site を意図的に配線したため、
// このテストのファイル自身のヘッダコメントが指示するとおり「配線が意図どおり行われていること」を
// 検証する routing test に置換する（本テストの旧版が red になったことで配線の存在を検出できた —
// 設計どおりの動作）。
//
// 検証内容:
//   1. .claude/workflows/dev-flow.js に trust-layer 参照が **ある**（Phase 2 で意図的に配線）
//   2. .claude/workflows/{pr-iterate,dev-improve}.js には trust-layer 参照が **無い**
//      （Phase 2 のスコープは dev-flow.js の Analyze phase のみ）
//   3. .claude/agents/*.md に trust-layer 参照が無い（新規 agent 型を追加しない設計）
//   4. tools/sync-inlines.mjs に trust-* 固有文字列が無い（generator は canonical path 非依存の
//      汎用マーカースキャナのまま — trust-mode.mjs の inline 追加は BEGIN/END マーカーで完結する）
//   5. dev-flow.js の配線が shadow 専用であること（configuredMode に 'shadow' 以外の mode 値
//      リテラルを使っていない）と、shadow 結果が req/ambiguities/mergeTier 等の既存 gate 変数へ
//      代入されていないこと（AC-11/AC-15: shadow は既存 gate を一切変えない）
//
// import パターンは _lib/gate-policy.test.mjs 冒頭を踏襲。新規 trust モジュールは
// import しない（並列 task と file/module 結合を作らない）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// trust-schema / trust-digest / trust-mode / trust-telemetry の各 canonical module 名、
// および 3 receipt schema の型名（大文字小文字表記ゆれ含む）を検出する regex。
const TRUST_REFERENCE_RE =
  /trust-(schema|digest|mode|telemetry|surfaceproof)|surfaceproof|evalseal|effectdelta|SurfaceProof|EvalSeal|EffectDelta/;

// ---- (1) dev-flow.js には意図的に配線がある ----

test('.claude/workflows/dev-flow.js に trust-layer 参照がある（issue #410, #390 Phase 2 の意図的配線）', () => {
  const content = readFileSync(join(REPO_ROOT, '.claude/workflows/dev-flow.js'), 'utf8');
  assert.equal(
    TRUST_REFERENCE_RE.test(content),
    true,
    'dev-flow.js に trust-layer 参照が見つからない（Phase 2 の SurfaceProof shadow 配線が失われている）'
  );
  assert.ok(content.includes('TRUST_SHADOW_REPO_SLUG'), 'trust-mode.mjs の inline（TRUST_SHADOW_REPO_SLUG）が無い');
  assert.ok(content.includes('resolveLayerMode'), 'trust-mode.mjs の resolveLayerMode inline が無い');
  assert.ok(content.includes('surfaceproof-snapshot.sh'), 'SurfaceProof shadow probe の exec-proxy 呼出しが無い');
});

// ---- (2) pr-iterate / dev-improve には配線が無い（Phase 2 のスコープ外） ----

const UNWIRED_WORKFLOW_FILES = [
  '.claude/workflows/pr-iterate.js',
  '.claude/workflows/dev-improve.js',
];

for (const relPath of UNWIRED_WORKFLOW_FILES) {
  test(`${relPath} に trust-layer 参照が無い（Phase 2 のスコープは dev-flow.js の Analyze phase のみ）`, () => {
    const content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    assert.equal(
      TRUST_REFERENCE_RE.test(content),
      false,
      `${relPath} に trust-layer 参照が見つかった（Phase 2 のスコープ外）`
    );
  });
}

// ---- (3) agents への配線ゼロ（新規 agent 型を追加しない設計） ----

const AGENTS_DIR = join(REPO_ROOT, '.claude/agents');
const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md'));

test('.claude/agents/ 配下に .md ファイルが存在する（テスト自体の健全性チェック）', () => {
  assert.ok(agentFiles.length > 0, '.claude/agents/*.md が見つからない');
});

for (const fileName of agentFiles) {
  test(`.claude/agents/${fileName} に trust-layer 参照が無い（新規 agent 型を追加せず既存 dev-runner-haiku-ro を再利用）`, () => {
    const content = readFileSync(join(AGENTS_DIR, fileName), 'utf8');
    assert.equal(
      TRUST_REFERENCE_RE.test(content),
      false,
      `.claude/agents/${fileName} に trust-layer 参照が見つかった（Phase 2 は既存 agent 型のみ使用する設計）`
    );
  });
}

// ---- (4) sync-inlines.mjs は canonical path 非依存の汎用マーカースキャナのまま ----

test('tools/sync-inlines.mjs に trust-* の固有文字列参照が無い（マーカーは path 非依存の汎用スキャナ）', () => {
  const content = readFileSync(join(REPO_ROOT, 'tools/sync-inlines.mjs'), 'utf8');
  assert.equal(
    content.includes('trust-'),
    false,
    'tools/sync-inlines.mjs に "trust-" 文字列が見つかった（generator は BEGIN/END マーカーの path を汎用スキャンするのみで良い）'
  );
});

// ---- (5) 配線は shadow 専用で、既存 gate 変数へ結果を代入していない ----

test('dev-flow.js の SurfaceProof 配線は shadow 専用（configuredMode に advisory/blocking を使わない）', () => {
  const content = readFileSync(join(REPO_ROOT, '.claude/workflows/dev-flow.js'), 'utf8');
  assert.ok(
    content.includes("configuredMode: 'shadow'"),
    "resolveLayerMode 呼出しが configuredMode: 'shadow' を使っていない"
  );
  assert.equal(
    /configuredMode:\s*'(advisory|blocking)'/.test(content),
    false,
    'dev-flow.js が configuredMode に advisory/blocking を渡している（Phase 2 は shadow 専用のはず）'
  );
});

test('dev-flow.js の SurfaceProof shadow 結果は既存 gate 変数（mergeTier/dangerHits/ambiguities）へ代入されていない', () => {
  const content = readFileSync(join(REPO_ROOT, '.claude/workflows/dev-flow.js'), 'utf8');
  assert.equal(
    /(mergeTier|dangerHits|ambiguities)\s*=[^=]*trustSurfaceProofShadow/.test(content),
    false,
    'trustSurfaceProofShadow が既存 gate 変数へ直接代入されている（AC-11/AC-15 違反の疑い）'
  );
});
