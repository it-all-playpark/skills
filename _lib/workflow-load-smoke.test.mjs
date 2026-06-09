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
//
// 修正点（旧実装の2つの欠陥を解消）:
//   (a) クロスレルム instanceof 問題: vm.runInContext が投げる Error は VM コンテキスト側の
//       レルムに属するため、外側の `instanceof ReferenceError` は常に false になる。
//       `.name` 文字列比較（クロスレルム安全）を使う。
//   (b) top-level await の parse SyntaxError マスキング: workflow ファイルは top-level に
//       `await agent(...)` を持つため、裸の runInContext は parse 時点で SyntaxError を投げ、
//       require 行に到達できない。ソースを async IIFE `(async () => { ... })()` で包んで評価し、
//       Promise rejection も await して捕捉する。
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

/**
 * workflow ソースを vm sandbox でロードし、発生したエラーを返す。
 * エラーがなければ null を返す。
 *
 * 2つの問題を同時に解消:
 *   (a) top-level await → async IIFE で包んで SyntaxError を回避
 *   (b) Promise rejection も await して捕捉（require は同期例外だが念のため）
 */
async function runWorkflowInSandbox(src, context, filename) {
  // ESM export 構文を strip
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');

  // top-level await を許容するため async IIFE で包む
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  try {
    const result = vm.runInContext(wrapped, context, { filename });
    // async IIFE が返す Promise の rejection も捕捉
    if (result && typeof result.then === 'function') {
      await result.catch((e) => { caughtError = e; });
    }
  } catch (e) {
    caughtError = e;
  }
  return caughtError;
}

for (const filePath of workflowFiles) {
  const relPath = filePath.replace(repoRoot + '/', '');

  test(`[vm-load] ${relPath}: 禁止グローバルなし sandbox でロードして ReferenceError が出ない`, async () => {
    const rawSrc = readFileSync(filePath, 'utf8');
    const context = makeWorkflowSandbox();
    const caughtError = await runWorkflowInSandbox(rawSrc, context, relPath);

    // クロスレルム安全な .name 比較（instanceof は VM レルム越えで常に false になる）
    // ReferenceError は禁止グローバルの使用 → ロード時即死 → 修正必須
    if (caughtError && caughtError.name === 'ReferenceError') {
      assert.fail(
        `${relPath} がロード時に ReferenceError で即死: ${caughtError.message}\n`
        + `（禁止グローバル require/process/Buffer 等を module top-level で使用している可能性）`,
      );
    }

    // SyntaxError は構文不正 → やはり修正必須
    if (caughtError && caughtError.name === 'SyntaxError') {
      assert.fail(`${relPath} がロード時に SyntaxError: ${caughtError.message}`);
    }

    // その他のエラー（TypeError 等）は top-level コードの実行による場合がある。
    // スタブが null を返すため発生しうるが、これはロード時の即死ではなく実行時の問題のため
    // 警告に留めテストは pass させる（ReferenceError / SyntaxError のみをブロッキングとする）。
  });
}

// ---- 3. Negative test: vm-load が実際に機能していることを保証 ---------------------------------
//
// テスト自身が inert 化していないことを検証するための fixture テスト。
// 禁止グローバルを含む合成ソースに対して vm-load が fail を検出できることを確認する。
// これにより「本物の退行を挿入してもテストが pass してしまう」再発を防ぐ。

test('[vm-load][negative] top-level require を含む合成ソースは ReferenceError として検出される', async () => {
  // 本物の退行を模したソース（top-level の require + await を含む）
  const badSrc = `
const _fs = require('fs');
const PR = '1';
const x = await Promise.resolve('test');
`;
  const context = makeWorkflowSandbox();
  const caughtError = await runWorkflowInSandbox(badSrc, context, '[fixture]');

  // このテストは必ず ReferenceError を検出できなければならない
  assert.ok(
    caughtError && caughtError.name === 'ReferenceError',
    `negative fixture: require を含むソースで ReferenceError が検出されるべきだが`
    + ` caughtError=${JSON.stringify(caughtError?.name)} (${caughtError?.message})`,
  );
});

test('[vm-load][negative] top-level process 使用を含む合成ソースは ReferenceError として検出される', async () => {
  const badSrc = `
const pid = process.pid;
const x = await Promise.resolve('test');
`;
  const context = makeWorkflowSandbox();
  const caughtError = await runWorkflowInSandbox(badSrc, context, '[fixture]');

  assert.ok(
    caughtError && caughtError.name === 'ReferenceError',
    `negative fixture: process を含むソースで ReferenceError が検出されるべきだが`
    + ` caughtError=${JSON.stringify(caughtError?.name)} (${caughtError?.message})`,
  );
});

test('[vm-load][negative] top-level Buffer 使用を含む合成ソースは ReferenceError として検出される', async () => {
  const badSrc = `
const b = Buffer.from('hello');
const x = await Promise.resolve('test');
`;
  const context = makeWorkflowSandbox();
  const caughtError = await runWorkflowInSandbox(badSrc, context, '[fixture]');

  assert.ok(
    caughtError && caughtError.name === 'ReferenceError',
    `negative fixture: Buffer を含むソースで ReferenceError が検出されるべきだが`
    + ` caughtError=${JSON.stringify(caughtError?.name)} (${caughtError?.message})`,
  );
});

// ---- 4. REQ schema shape フィールド検証 ---------------------------------------------------
//
// dev-flow.js の REQ schema に shape enum フィールドが追加されていることを確認する。
// shape は LLM が emit する optional フィールド（required に含めない）。

test('[schema] dev-flow.js: REQ schema は valid object である', () => {
  const devFlowPath = join(workflowDir, 'dev-flow.js');
  const rawSrc = readFileSync(devFlowPath, 'utf8');

  assert.ok(rawSrc.includes('const REQ ='), 'REQ schema が dev-flow.js に定義されていること');
  assert.ok(
    rawSrc.includes("'object'") || rawSrc.includes('"object"'),
    'REQ schema が type: object を持つこと',
  );
});

test('[schema] dev-flow.js: REQ schema に shape enum プロパティが存在する', () => {
  const devFlowPath = join(workflowDir, 'dev-flow.js');
  const rawSrc = readFileSync(devFlowPath, 'utf8');

  assert.ok(
    rawSrc.includes("shape:") && rawSrc.includes("'micro'") && rawSrc.includes("'standard'") && rawSrc.includes("'complex'"),
    "REQ schema に shape: { type: string, enum: ['micro', 'standard', 'complex'] } が存在すること",
  );
});

test('[schema] dev-flow.js: shape は required 配列に含まれない（optional フィールド）', () => {
  const devFlowPath = join(workflowDir, 'dev-flow.js');
  const rawSrc = readFileSync(devFlowPath, 'utf8');

  const reqMatch = rawSrc.match(/const REQ\s*=\s*\{[\s\S]*?required:\s*\[([^\]]*)\]/);
  assert.ok(reqMatch, 'REQ schema の required 配列が取得できること');
  const requiredContent = reqMatch[1];
  assert.ok(
    !requiredContent.includes('shape'),
    'REQ schema の required に shape が含まれていないこと',
  );
});

// ---- 5. triage consume: classifyShape を使い TRIVIAL = (SHAPE==='micro') にマップ --------
//
// triage consume が classifyTriviality ではなく classifyShape を使っていることを確認する。
// TRIVIAL = (SHAPE === 'micro') の式で micro が trivial 経路にマップされていることを確認。

test('[triage] dev-flow.js: classifyShape を triage consume に使用している', () => {
  const devFlowPath = join(workflowDir, 'dev-flow.js');
  const rawSrc = readFileSync(devFlowPath, 'utf8');

  assert.ok(
    rawSrc.includes('classifyShape(req)'),
    'triage consume で classifyShape(req) を呼び出していること',
  );
  assert.ok(
    !rawSrc.includes('classifyTriviality'),
    'classifyTriviality は削除され残存しないこと',
  );
});

test('[triage] dev-flow.js: SHAPE 変数と TRIVIAL = (SHAPE === micro) が定義されている', () => {
  const devFlowPath = join(workflowDir, 'dev-flow.js');
  const rawSrc = readFileSync(devFlowPath, 'utf8');

  assert.ok(
    rawSrc.includes('const SHAPE =') || rawSrc.includes('const SHAPE='),
    'SHAPE 変数が定義されていること',
  );
  assert.ok(
    rawSrc.includes("SHAPE === 'micro'"),
    "TRIVIAL = (SHAPE === 'micro') でマッピングされていること",
  );
});

test('[triage] dev-flow.js: 最終 return に shape: SHAPE が含まれる', () => {
  const devFlowPath = join(workflowDir, 'dev-flow.js');
  const rawSrc = readFileSync(devFlowPath, 'utf8');

  assert.ok(
    rawSrc.includes('shape: SHAPE'),
    '最終 return オブジェクトに shape: SHAPE が含まれること',
  );
});
