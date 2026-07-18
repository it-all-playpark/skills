// _lib/analyze-contract-routing.test.mjs
// Guard test: Analyze phase の決定論 parse 降格経路 (contract probe → buildReqFromContract →
// fail-open fallback) の配線 pin（issue #374 task F2）。
//
// probe label は 'contract-probe#' + ISSUE（'analyze-contract#' ではない）: 既存の
// *-routing.test.mjs 群が label.startsWith('analyze') で sonnet analyze 呼び出し回数を厳密カウントして
// いるため、'analyze' prefix と衝突する label にすると call count アサーションを大量に壊してしまう
// （AC-2「既存の抽出結果・挙動が変わらない」に反する）。'contract-probe#' なら既存 responder の
// どの分岐にもマッチせず null を返す → 本経路の fail-open ロジックがそのまま現行 analyze# fallback に
// 委譲するため、既存テストの呼び出し回数・挙動は完全に不変となる。
//
// .claude/workflows/*.js はランタイム注入 global を使うため ESM import できない。
// よって既存 *-routing.test.mjs と同じ戦略 (source-as-string assert) で検証する。
//
// Run: npx vitest run _lib/analyze-contract-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- (a) label 'contract-probe#' と agentType 'dev-runner-haiku-ro' が Analyze phase に存在 ----
// contract probe は read-only 決定論 proxy（Write/Edit 禁止を prompt 自身が宣言）のため、
// AGENTS.md の exec-proxy 分離規約に従い dev-runner-haiku-ro（tools: [Bash, Read] のみ）を
// 使用する（PR #388 review, major #2）。

test("[analyze-contract-routing] (a) label 'contract-probe#' が dev-flow.js に存在する", () => {
  assert.ok(src.includes("'contract-probe#'"), "label 'contract-probe#' が見つからない");
});

test("[analyze-contract-routing] (a) 'contract-probe#' の agent() 呼び出しが agentType:'dev-runner-haiku-ro' を使う", () => {
  const idx = src.indexOf("'contract-probe#'");
  assert.ok(idx !== -1);
  const window = src.slice(Math.max(0, idx - 200), idx + 300);
  assert.match(
    window,
    /agentType:\s*'dev-runner-haiku-ro'/,
    `'contract-probe#' 呼び出し周辺に agentType:'dev-runner-haiku-ro' が見つからない。window: ${window}`,
  );
});

// ---- (b) probe は try/catch + non-need()（fail-open）----

test('[analyze-contract-routing] (b) contract-probe は need() で包まれていない（fail-open）', () => {
  const idx = src.indexOf("'contract-probe#'");
  assert.ok(idx !== -1);
  const before = src.slice(Math.max(0, idx - 300), idx);
  assert.doesNotMatch(
    before,
    /need\(\s*await agent\(/,
    'contract-probe は need() で包んではならない (fail-open policy)',
  );
});

test('[analyze-contract-routing] (b) contract-probe は try/catch で包まれている', () => {
  const idx = src.indexOf("'contract-probe#'");
  assert.ok(idx !== -1);
  const before = src.slice(Math.max(0, idx - 400), idx);
  const after = src.slice(idx, idx + 600);
  assert.match(before, /try\s*\{/, 'contract-probe の前に try { が見つからない');
  assert.match(after, /\}\s*catch/, 'contract-probe の後に catch ブロックが見つからない');
});

// ---- (c) fallback の analyze# sonnet 呼び出しと needs_clarification 判定文字列が不変で存在 ----

test("[analyze-contract-routing] (c) fallback の 'analyze#' + ISSUE (dev-runner) 呼び出しが存在する", () => {
  assert.match(src, /label:\s*`analyze#\$\{ISSUE\}`/, "label: `analyze#${ISSUE}` が見つからない");
  const idx = src.search(/label:\s*`analyze#\$\{ISSUE\}`/);
  assert.ok(idx !== -1);
  const window = src.slice(Math.max(0, idx - 200), idx + 100);
  assert.match(window, /agentType:\s*'dev-runner'/, `analyze#\${ISSUE} 呼び出しは agentType:'dev-runner' のままであること。window: ${window}`);
});

test('[analyze-contract-routing] (c) needs_clarification 判定文字列が不変', () => {
  assert.ok(src.includes('needs_clarification で中断'), "'needs_clarification で中断' の log 文言が見つからない（既存挙動が変更された可能性）");
  assert.ok(src.includes("status: 'needs_clarification'"), "status: 'needs_clarification' が見つからない");
});

// ---- (d) DEPTH === 'standard' ガードの存在 ----

test("[analyze-contract-routing] (d) \"DEPTH === 'standard'\" ガードが存在する", () => {
  assert.match(src, /DEPTH === 'standard'/, "DEPTH === 'standard' ガードが見つからない");
});

// ---- (e) bare 形実行指示（cd 前置禁止文言）が prompt に含まれる ----

test('[analyze-contract-routing] (e) contract probe prompt に cd 前置禁止の bare 形指示が含まれる', () => {
  const idx = src.indexOf('analyze-issue.sh ${ISSUE} --contract');
  assert.ok(idx !== -1, "'analyze-issue.sh ${ISSUE} --contract' 実行コマンドが prompt 内に見つからない");
  const window = src.slice(Math.max(0, idx - 100), idx + 500);
  assert.match(window, /cd 前置/, `cd 前置禁止の文言が見つからない。window: ${window}`);
});

test('[analyze-contract-routing] (e) script 呼び出しが WT 絶対パス先頭トークンの bare 形である', () => {
  assert.match(
    src,
    /\$\{WT\}\/dev-issue-analyze\/scripts\/analyze-issue\.sh \$\{ISSUE\} --contract/,
    '${WT}/dev-issue-analyze/scripts/analyze-issue.sh ${ISSUE} --contract という絶対パス先頭トークン形式が見つからない',
  );
});
