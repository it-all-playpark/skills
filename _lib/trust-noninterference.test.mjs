// issue #409 (#390 Phase 1) 非干渉 guard。
// Phase 2+ で trust-layer を既存 dev-flow に配線する PR は、このテストを
// 「配線が意図どおり行われていること」を検証する配線 routing test に置換すること
// （本テストは「配線ゼロ」を固定するものであり、配線後は自動的に red になる設計）。
//
// 検証内容:
//   1. .claude/workflows/{dev-flow,pr-iterate,dev-improve}.js に trust-layer 参照が無い
//   2. .claude/agents/*.md に trust-layer 参照が無い
//   3. tools/sync-inlines.mjs に trust-* inline マーカーが無い
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
  /trust-(schema|digest|mode|telemetry)|surfaceproof|evalseal|effectdelta|SurfaceProof|EvalSeal|EffectDelta/;

const WORKFLOW_FILES = [
  '.claude/workflows/dev-flow.js',
  '.claude/workflows/pr-iterate.js',
  '.claude/workflows/dev-improve.js',
];

// ---- (1) workflows への配線ゼロ ----

for (const relPath of WORKFLOW_FILES) {
  test(`${relPath} に trust-layer 参照が無い（Phase 1 非干渉・追加のみ）`, () => {
    const content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    assert.equal(
      TRUST_REFERENCE_RE.test(content),
      false,
      `${relPath} に trust-layer 参照が見つかった（Phase 1 では配線禁止）`
    );
  });
}

// ---- (2) agents への配線ゼロ ----

const AGENTS_DIR = join(REPO_ROOT, '.claude/agents');
const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md'));

test('.claude/agents/ 配下に .md ファイルが存在する（テスト自体の健全性チェック）', () => {
  assert.ok(agentFiles.length > 0, '.claude/agents/*.md が見つからない');
});

for (const fileName of agentFiles) {
  test(`.claude/agents/${fileName} に trust-layer 参照が無い（Phase 1 非干渉・追加のみ）`, () => {
    const content = readFileSync(join(AGENTS_DIR, fileName), 'utf8');
    assert.equal(
      TRUST_REFERENCE_RE.test(content),
      false,
      `.claude/agents/${fileName} に trust-layer 参照が見つかった（Phase 1 では配線禁止）`
    );
  });
}

// ---- (3) sync-inlines.mjs への trust-* inline マーカー追加ゼロ ----

test('tools/sync-inlines.mjs に trust-* の inline マーカー追加が無い', () => {
  const content = readFileSync(join(REPO_ROOT, 'tools/sync-inlines.mjs'), 'utf8');
  assert.equal(
    content.includes('trust-'),
    false,
    'tools/sync-inlines.mjs に "trust-" 文字列が見つかった（Phase 1 は workflow inline 生成対象外）'
  );
});
