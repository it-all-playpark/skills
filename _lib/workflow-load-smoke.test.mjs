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

import { test } from 'vitest';
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

// ---- 6. W5: danger-grep 配線 + merge tier --------------------------------------------------

// issue #495 の trust-layer 証跡書き込み（--out）は #549 の call site 撤去、
// issue #544 の Security floor 4→1 統合を経て撤去済み。Security floor 側の danger-grep は
// secfloor-classify.sh 経由の統合呼び出し（label 'danger-grep'）になり diff-risk-classify.sh を
// 直接は呼ばない（統合スクリプト内部から --working-tree 付きで呼ばれる）。Merge tier の
// danger-grep-final はフラグ無し三点 diff のまま diff-risk-classify.sh を直接呼び、--out は
// 使わない。
test('[W5] dev-flow.js: RISK schema と Merge tier の diff-risk-classify 呼び出しが存在し、--out は使わない', () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  assert.ok(src.includes('const RISK ='), 'RISK schema があること');
  assert.ok(src.includes("required: ['ok', 'hits']"), 'RISK schema が ok error channel を必須にすること');
  assert.ok(src.includes('diff-risk-classify.sh'), '（Merge tier の danger-grep-final 経由で）diff-risk-classify.sh を呼ぶこと');
  assert.ok(
    src.includes('bash ~/.claude/skills/_shared/scripts/diff-risk-classify.sh origin/${' + 'BASE}'),
    'Merge tier の danger-grep-final はフラグ無し三点 diff で diff-risk-classify.sh を呼ぶこと',
  );
  assert.ok(!src.includes('--out'), '証跡書き込み --out は撤去済みであること（issue #544 AC1）');
  assert.ok(!src.includes('--working-tree'), 'dev-flow.js 自体は --working-tree を直接指定しない（secfloor-classify.sh 内部の呼び出しに委譲）');
});

test('[W5] dev-flow.js: 常時 SEC seed と runEval gate が存在', () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  assert.ok(src.includes('seedSecurityLedger('), 'SEC seed を積むこと');
  assert.ok(src.includes('const runEval ='), 'runEval gate があること');
  assert.ok(src.includes('reconcileDanger('), 'danger 反映を行うこと');
});

test('[W5] dev-flow.js: merge tier 算出と return フィールドが存在', () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  assert.ok(src.includes('classifyMergeTier('), 'classifyMergeTier を呼ぶこと');
  assert.ok(src.includes('merge_tier:'), 'return に merge_tier があること');
  assert.ok(src.includes("phase('Merge tier')"), 'Merge tier phase があること');
});

// ---- 7. issue #443: clock epoch 給電 prompt の退行検出 --------------------------------------
//
// 専用 clock probe（dev-runner-haiku-ro の clockProbe() 呼び出し）は Setup 冒頭の start と
// Merge tier 末尾の end の 2 回のみに削減され、残り 9 mark は隣接する既存 exec-proxy / agent
// 応答の optional epoch フィールドから feedClockMark() 経由で給電される。給電元 prompt は
// 末尾に EPOCH_INSTRUCTION（`date +%s` を 1 回実行し epoch として返せという指示）を追記して
// いる。この指示が silent に prompt から失われる退行を検出するため:
//   (a) EPOCH_INSTRUCTION 自体の定義が `date +%s` を実行する指示であること
//   (b) 給電対象 prompt 定義（PLANNER_HANDOFF_RULE / STAGING_CONVENTION / VALIDATE_TEST_PROMPT /
//       reviewPromptLite / contractProbePrompt）の近傍に EPOCH_INSTRUCTION 参照が存在すること
//   (c) 専用 clock probe の呼び出し（clockProbe('...')）が clockProbe('start' / clockProbe('end')
//       の 2 箇所のみであること（AC-1 の静的検出）
// をソース文字列 assert で保証する。

test('[epoch-instruction] dev-flow.js: EPOCH_INSTRUCTION の定義自体が `date +%s` を実行する指示を含む', () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  const m = src.match(/const EPOCH_INSTRUCTION\s*=\s*'([^']*)'/);
  assert.ok(m, 'EPOCH_INSTRUCTION の定義（`const EPOCH_INSTRUCTION = \'...\'`）が dev-flow.js に見つかること');
  assert.ok(
    m[1].includes('date +%s'),
    `EPOCH_INSTRUCTION の定義に "date +%s" 指示が含まれるべきだが含まれていなかった: ${m[1]}`,
  );
});

/**
 * src を行分割し、anchorPattern に最初にマッチした行から windowLines 行分を切り出して返す。
 * 見つからなければ null。
 */
function sourceWindowAfterAnchor(src, anchorPattern, windowLines) {
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => anchorPattern.test(l));
  if (idx === -1) return null;
  return lines.slice(idx, idx + windowLines).join('\n');
}

// [定数名/アンカー行に一致する正規表現, 切り出す行数] — 各 prompt 定義の近傍に
// EPOCH_INSTRUCTION 参照（date +%s 給電指示）が存在することを検証する対象。
const EPOCH_FED_PROMPT_ANCHORS = [
  ['PLANNER_HANDOFF_RULE', /^\s*const PLANNER_HANDOFF_RULE\b/, 6],
  ['STAGING_CONVENTION', /^\s*const STAGING_CONVENTION\b/, 10],
  ['VALIDATE_TEST_PROMPT', /^\s*const VALIDATE_TEST_PROMPT\b/, 15],
  ['reviewPromptLite', /^\s*const reviewPromptLite\b/, 10],
  ['contractProbePrompt', /^\s*const contractProbePrompt\b/, 20],
];

for (const [name, anchorPattern, windowLines] of EPOCH_FED_PROMPT_ANCHORS) {
  test(`[epoch-instruction] dev-flow.js: ${name} 定義の近傍に epoch 取得指示（EPOCH_INSTRUCTION）が含まれる`, () => {
    const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
    const region = sourceWindowAfterAnchor(src, anchorPattern, windowLines);
    assert.ok(region, `${name} の定義箇所（アンカー行）が dev-flow.js に見つかること`);
    assert.ok(
      region.includes('EPOCH_INSTRUCTION'),
      `${name} の定義（近傍 ${windowLines} 行）に EPOCH_INSTRUCTION 参照が含まれるべきだが含まれていなかった:\n${region}`,
    );
  });
}

test("[epoch-instruction] dev-flow.js: clockProbe(' の呼び出しは clockProbe('start' と clockProbe('end' の 2 箇所のみ", () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  const clockProbeCalls = [...src.matchAll(/clockProbe\('[^']*'/g)].map((m) => m[0]);
  assert.equal(
    clockProbeCalls.length,
    2,
    `clockProbe(' の呼び出しはちょうど 2 箇所であるべきだが ${clockProbeCalls.length} 箇所だった: ${JSON.stringify(clockProbeCalls)}`,
  );
  assert.deepEqual(
    [...clockProbeCalls].sort(),
    ["clockProbe('end'", "clockProbe('start'"],
    `clockProbe(' の呼び出しは clockProbe('start' / clockProbe('end') の 2 種のみであるべきだが ${JSON.stringify(clockProbeCalls)} だった`,
  );
});
