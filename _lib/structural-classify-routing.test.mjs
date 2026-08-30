// Guard test: structural-classify (struct フィールド) の fail-open / i===1 gating / realizedCount
// exclusion / schema fail-open tolerance (issue #350, task F2; issue #550 S2 で統合呼び出し経由へ更新)。
//
// Background:
//   dev-flow.js の Security floor phase はもともと F1 の決定論 script
//   `_shared/scripts/structural-classify.sh` を専用 label 'structural-classify' の
//   dev-runner-haiku-ro exec-proxy 経由で個別に呼んでいたが、issue #550 (S1) で
//   danger-grep(risk) / realized-diff(files) / structural-classify(struct) / diff-hash-secfloor(hash)
//   の 4 呼び出しが統合スクリプト `_shared/scripts/secfloor-classify.sh` 経由の単一呼び出し
//   （label 'danger-grep' 据え置き）へ集約された。struct 分類データはその応答の `struct` フィールド
//   として得られ、`_lib/secfloor-unified.mjs` の `parseSecfloorFields`（dev-flow.js へ inline 生成
//   済み）が per-field 独立に fail-open 検証する: struct が null / ok!==true / available 非boolean /
//   format_only・structural 非配列のいずれでも struct=null（呼び出し元は formatOnlySet を空にして
//   現行動作 = 全ファイル structural 扱い相当へフォールバックする）。
//
//   .claude/workflows/*.js はランタイム注入 global を使うため ESM import できない。
//   よって _lib/exec-proxy-routing.test.mjs と同じ戦略 (source-as-string regex) で検証する。
//
// Run: npx vitest run _lib/structural-classify-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ---- (1)/(2)/(3) 統合後の struct フィールド抽出は execSecurityFloorPhase 側の
//      parseSecfloorFields(unified) 呼び出し（try/catch で包まれ need() では包まれない、
//      label 'danger-grep' が dev-runner-haiku-ro へ routing される）が担う。
//      その routing / try-catch pin は _lib/secfloor-unified-routing.test.mjs の
//      [A1]/[A5] で検証済みのため、ここでは重複検証しない。
//      本ファイルでは struct フィールド専用の fail-open 純関数（parseStructField、
//      dev-flow.js へ inline 生成済み）の存在と fail-open 条件のみを source pin する。

test('[structural-classify-routing] parseStructField (secfloor-unified.mjs から inline 生成) が dev-flow.js に存在し、struct.ok!==true / available 非boolean / structural・format_only 非配列を fail-open (null) で扱う', () => {
  const idx = devFlowSrc.indexOf('function parseStructField(unified)');
  assert.ok(idx !== -1, 'dev-flow.js に parseStructField(unified) の inline 生成関数が見つからない');
  const endIdx = devFlowSrc.indexOf('\n}\n', idx);
  assert.ok(endIdx !== -1, 'parseStructField 関数本体の終端が見つからない');
  const body = devFlowSrc.slice(idx, endIdx);

  assert.match(body, /struct\.ok === true/, 'parseStructField は struct.ok===true を要求すべき');
  assert.match(body, /typeof struct\.available === 'boolean'/, 'parseStructField は typeof struct.available===\'boolean\' を要求すべき');
  assert.match(body, /Array\.isArray\(struct\.format_only\)/, 'parseStructField は format_only の配列検証を行うべき');
  assert.match(body, /return null/, 'parseStructField は検証不合格時に null を返す（fail-open）べき');
});

// ---- (4) evaluator prompt injection is gated by i === 1 (same as focus_areas / ui_verification) ----

test('[structural-classify-routing] diff_classification prompt injection is gated by i === 1', () => {
  assert.match(
    devFlowSrc,
    /i === 1 && state\.diffClassification/,
    'diff_classification injection into the evaluator prompt must be gated by "i === 1 && state.diffClassification" '
    + '(iteration 2+ must not reuse a stale classification, per focus_areas/ui_verification precedent)',
  );
});

// ---- (5) realizedCount excludes format_only files ----

test('[structural-classify-routing] realizedCount computation excludes format_only files via formatOnlySet', () => {
  assert.match(devFlowSrc, /formatOnlySet/, 'expected a formatOnlySet to be derived from the structural-classify result');
  assert.match(
    devFlowSrc,
    /formatOnlyExcluded/,
    'expected a formatOnlyExcluded count used to exclude format-only files from realizedCount and to log the exclusion',
  );
});

// ---- (6) SECFLOOR schema fail-open/fail-safe tolerance: required is [] (no field required) ----
//
// struct はもはや専用スキーマを持たず、統合スキーマ SECFLOOR の一部として応答される。
// SECFLOOR は required:[] で応答全体を reject しない（1 フィールドの型崩れが正常フィールド
// まで巻き込むのを防ぐ。ambiguity 2 の解決。struct の可否は SECFLOOR ではなく
// parseStructField 側の JS レベル検証が担う）。

test("[structural-classify-routing] SECFLOOR schema requires no field (struct を含む全フィールドがスキーマレベルでは任意)", () => {
  const idx = devFlowSrc.indexOf('const SECFLOOR');
  assert.ok(idx !== -1, 'Could not find SECFLOOR schema definition in dev-flow.js');
  const window = devFlowSrc.slice(idx, idx + 300);
  assert.match(
    window,
    /required:\s*\[\s*\]/,
    `SECFLOOR schema 'required' should be [] (fail-open/fail-safe tolerance for all fields), got window: ${window}`,
  );
  assert.match(window, /struct:\s*\{\s*type:\s*\[\s*'object',\s*'null'\s*\]\s*\}/, 'SECFLOOR schema should type struct as object|null');
});

// ---- (7) state.diffClassification is persisted for the i===1 evaluator prompt to consume ----

test('[structural-classify-routing] state.diffClassification is assigned in execSecurityFloorPhase', () => {
  assert.match(
    devFlowSrc,
    /state\.diffClassification\s*=/,
    'expected state.diffClassification to be assigned so the Evaluate phase can read it',
  );
});
