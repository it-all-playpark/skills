// Load-smoke tests: .claude/workflows/*.js が workflow runtime でロード時に即死しないことを保証する。
//
// 背景: dynamic workflow ローダーは独自の VM コンテキストで各 workflow ファイルを評価する。
// ローダーは require/process/Buffer/Date.now() 等の Node API を提供しない。
// module top-level でこれらを呼ぶとロード直後に ReferenceError で即死する。
// byte 一致テスト（sync.test.mjs）はこの退行を検出できないため、本テストを追加する。
//
// アプローチ:
//   1. 文字列 lint: ソースに module top-level の `require(` / `Date.now(` が出現しないことを検査。
//      （最低限の安全網。関数本体内は許可するが、top-level スコープでは禁止）
//   2. VM sandbox: 禁止グローバルを持たない最小コンテキスト（agent/parallel/phase/log/workflow/args
//      を stub）で runInNewContext を実行し、ReferenceError を投げないことを assert する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.claude/workflows');

// Discover all *.js workflow files
const workflowFiles = readdirSync(workflowDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(workflowDir, f));

// ---- 1. String lint: 禁止パターンが module top-level に存在しないことを検査 ------------------
//
// 戦略: インデントゼロ（top-level）の行に禁止パターンが出現するケースを検出する。
// `const xxx = require(` / `require(` の直接呼び出しを対象とする。

const FORBIDDEN_TOP_LEVEL = [
  // [pattern, label]
  [/^(?:const|let|var)\s+\S+\s*=\s*require\s*\(/, 'module top-level の require() 呼び出し'],
  [/^require\s*\(/, 'module top-level の require() 直接呼び出し'],
];

// Date.now() は関数本体内では許可するが、top-level の variable initializer では禁止
// 例: `const ts = Date.now()` を禁止
const FORBIDDEN_TOP_LEVEL_DATE = /^(?:const|let|var)\s+\S+\s*=.*\bDate\.now\s*\(/;

for (const filePath of workflowFiles) {
  const relPath = filePath.replace(repoRoot + '/', '');
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');

  test(`[string-lint] ${relPath}: module top-level に require() が存在しない`, () => {
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [pattern, label] of FORBIDDEN_TOP_LEVEL) {
        if (pattern.test(line)) {
          violations.push(`line ${i + 1}: ${label} — ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${relPath} に禁止パターン（require）が含まれている:\n${violations.join('\n')}`,
    );
  });

  test(`[string-lint] ${relPath}: module top-level に Date.now() initializer が存在しない`, () => {
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (FORBIDDEN_TOP_LEVEL_DATE.test(line)) {
        violations.push(`line ${i + 1}: top-level Date.now() — ${line.trim()}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${relPath} に禁止パターン（Date.now top-level initializer）が含まれている:\n${violations.join('\n')}`,
    );
  });
}

// ---- 2. VM sandbox load test: ReferenceError を投げないことを assert -------------------------
//
// workflow ローダーが提供する最小グローバルをスタブとして注入し、
// runInContext でファイルを評価する。
// 評価は top-level の同期コードのみ実行される（await は async function 内なので skip される）。
// ReferenceError が出ればここで検出できる。
//
// 注意: `export const meta = ...` は ESM 構文のため CJS sandbox では SyntaxError になる。
// ローダーと同様の最小変換として export キーワードを strip して評価する。

function makeWorkflowSandbox(extraGlobals = {}) {
  // workflow runtime が提供するグローバルをスタブ
  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: async () => null,
    parallel: async () => [],
    workflow: async () => null,
    // 引数（実 loader は args を注入する）
    args: '1',
    // JS 組み込み（vm.createContext はデフォルトで提供しないため明示注入）
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
    // require / process / Buffer は意図的に注入しない（禁止グローバル）
    ...extraGlobals,
  };
  return vm.createContext(sandbox);
}

for (const filePath of workflowFiles) {
  const relPath = filePath.replace(repoRoot + '/', '');

  test(`[vm-load] ${relPath}: 禁止グローバルなし sandbox でロードして ReferenceError が出ない`, () => {
    const rawSrc = readFileSync(filePath, 'utf8');

    // ESM export 構文を CJS sandbox 向けに strip
    // ローダーと同様の最小変換: `export const` → `const`, `export function` → `function`
    const src = rawSrc
      .replace(/^export\s+const\s+/gm, 'const ')
      .replace(/^export\s+function\s+/gm, 'function ');

    const context = makeWorkflowSandbox();

    let caughtError = null;
    try {
      vm.runInContext(src, context, { filename: relPath });
    } catch (e) {
      caughtError = e;
    }

    // ReferenceError は禁止グローバルの使用 → ロード時即死 → 修正必須
    if (caughtError instanceof ReferenceError) {
      assert.fail(
        `${relPath} がロード時に ReferenceError で即死: ${caughtError.message}\n`
        + `（禁止グローバル require/process/Buffer 等を module top-level で使用している可能性）`,
      );
    }

    // SyntaxError は構文不正 → やはり修正必須
    if (caughtError instanceof SyntaxError) {
      assert.fail(`${relPath} がロード時に SyntaxError: ${caughtError.message}`);
    }

    // その他のエラー（TypeError 等）は top-level コードの実行による場合がある。
    // スタブが null を返すため発生しうるが、これはロード時の即死ではなく実行時の問題のため
    // 警告に留めテストは pass させる（ReferenceError / SyntaxError のみをブロッキングとする）。
  });
}
