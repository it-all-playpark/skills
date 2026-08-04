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
// issue #466: analyze-issue.sh は --issue-json ファイル入力の純変換へ改修されたため、
// contract probe は事前に bare `gh issue view` で issue JSON を $TMPDIR file へ取得してから
// script を --issue-json 付きで呼ぶ 2 段階 choreography になった。

test('[analyze-contract-routing] (e) contract probe prompt に cd 前置禁止の bare 形指示が含まれる', () => {
  const idx = src.indexOf('analyze-issue.sh ${ISSUE} --issue-json');
  assert.ok(idx !== -1, "'analyze-issue.sh ${ISSUE} --issue-json' 実行コマンドが prompt 内に見つからない");
  const window = src.slice(Math.max(0, idx - 100), idx + 500);
  assert.match(window, /cd 前置/, `cd 前置禁止の文言が見つからない。window: ${window}`);
});

test('[analyze-contract-routing] (e) script 呼び出しが skills 実体固定パス先頭トークンの bare 形である', () => {
  assert.match(
    src,
    /~\/\.claude\/skills\/dev-issue-analyze\/scripts\/analyze-issue\.sh \$\{ISSUE\} --issue-json <ISSUE_JSON> --contract/,
    '~/.claude/skills/dev-issue-analyze/scripts/analyze-issue.sh ${ISSUE} --issue-json <ISSUE_JSON> --contract という絶対パス先頭トークン形式が見つからない',
  );
});

test('[analyze-contract-routing] (e) contract probe prompt が issue JSON を bare `gh issue view` で先行取得する', () => {
  const idx = src.indexOf("'contract-probe#'");
  assert.ok(idx !== -1);
  const window = src.slice(Math.max(0, idx - 200), idx + 2000);
  assert.match(window, /gh issue view \$\{ISSUE\}/, `bare 'gh issue view \${ISSUE}' 実行指示が見つからない。window: ${window}`);
});

// ---- (f) 分類器 trigger 文言（sandbox/excludedCommands 起動理由の説明）を含まない ----
// issue #466 AC-1: prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない
// （分類器 trigger）。前置禁止の指示自体は (e) で別途固定済み。

test("[analyze-contract-routing] (f) contract probe prompt が 'sandbox'/'excludedCommands' を含まない", () => {
  const idx = src.indexOf("'contract-probe#'");
  assert.ok(idx !== -1);
  const window = src.slice(idx, idx + 2500);
  assert.doesNotMatch(window, /sandbox/, `contract probe prompt に 'sandbox' が含まれてはならない。window: ${window}`);
  assert.doesNotMatch(window, /excludedCommands/, `contract probe prompt に 'excludedCommands' が含まれてはならない。window: ${window}`);
});
