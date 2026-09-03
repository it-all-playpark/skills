// _lib/analyze-prompt-calibration.test.mjs
// Pin test: analyzePrompt の bias 撤去 + shape 定義境界一致 + AC 粒度ガイダンス、
// PLANNER_HANDOFF_RULE の全 planner spawn prompt への注入を dev-flow.js のソース文字列に対して固定する。
// (issue #272 — plan-reviewer 指摘 logic-bug::analyze-prompt-micro-definition 対応)
//
// VM 実行不要: readFileSync でソース文字列を assert するだけの静的 pin テスト。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wfPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(wfPath, 'utf8');

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// (a) 「迷えば大きめ」が 0 回出現（bias 文言の完全撤去）
test('analyzePrompt: 「迷えば大きめ」が 0 回出現', () => {
  assert.equal(countOccurrences(src, '迷えば大きめ'), 0);
});

// (b) 「安全側=complex 寄り」が出現しない
test('analyzePrompt: 「安全側=complex 寄り」が出現しない', () => {
  assert.ok(!src.includes('安全側=complex 寄り'));
});

// (c) 「micro=1〜2 ファイル」が存在（決定論 floor との境界一致 pin）
test('analyzePrompt: 「micro=1〜2 ファイル」が存在', () => {
  assert.ok(src.includes('micro=1〜2 ファイル'));
});

// (d) 「単一ファイル軽微変更」が出現しない（旧定義の残置なし）
test('analyzePrompt: 「単一ファイル軽微変更」が出現しない', () => {
  assert.ok(!src.includes('単一ファイル軽微変更'));
});

// (e) 「AC 4 個以内」が存在（classifyShape ac<=4 との一致 pin）
test('analyzePrompt: 「AC 4 個以内」が存在', () => {
  assert.ok(src.includes('AC 4 個以内'));
});

// (f) 「最小単位へ統合」が存在（AC 粒度ガイダンス pin）
test('analyzePrompt: 「最小単位へ統合」が存在', () => {
  assert.ok(src.includes('最小単位へ統合'));
});

// (g) 「大きめに倒すな」が存在（anti-bias pin）
test('analyzePrompt: 「大きめに倒すな」が存在', () => {
  assert.ok(src.includes('大きめに倒すな'));
});

// (h) 「.devflow-tmp/ 配下のパスを指定せよ」が存在し、
//     PLANNER_HANDOFF_RULE 参照が 4 箇所以上（planner spawn 全系統への注入 pin）
test('PLANNER_HANDOFF_RULE: 「.devflow-tmp/ 配下のパスを指定せよ」が存在', () => {
  assert.ok(src.includes('.devflow-tmp/ 配下のパスを指定せよ'));
});

test('PLANNER_HANDOFF_RULE: dev-flow.js 内の参照が 4 箇所以上', () => {
  const refCount = countOccurrences(src, 'PLANNER_HANDOFF_RULE');
  assert.ok(refCount >= 4, `PLANNER_HANDOFF_RULE 参照は ${refCount} 箇所（4 箇所以上が必要）`);
});

// issue #278: breaking 判定を LLM 自由文 (scope/summary への regex) から、analyze REQ の
// 構造化 breaking_change フィールド + issue 本文への決定論 keyword scan の OR へ置換した pin。

// (i) 「breaking_keyword_scan」が analyzePrompt と REQ schema の両方に存在する（3 箇所以上）
test('breaking_keyword_scan: dev-flow.js 内の参照が 3 箇所以上（analyzePrompt + REQ schema）', () => {
  const refCount = countOccurrences(src, 'breaking_keyword_scan');
  assert.ok(refCount >= 3, `breaking_keyword_scan 参照は ${refCount} 箇所（3 箇所以上が必要）`);
});

// (j) 「breaking_evidence」が存在する
test('breaking_evidence: dev-flow.js 内に存在', () => {
  assert.ok(src.includes('breaking_evidence'));
});

// (k) isBreakingText（旧 LLM 自由文 regex 実装）の参照が 0 件
test('isBreakingText: dev-flow.js 内の参照が 0 件', () => {
  assert.equal(countOccurrences(src, 'isBreakingText'), 0);
});
