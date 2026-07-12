// dev-flow.js の meta.phases と実 phase() 呼び出しの整合性を source-string assertion で検証する。
// empty-diff gate の phase ラベルが正しく 'Validate' であること、
// declared-path-check の phase: 'Validate' ラベルが存在しない（F3 porcelain 統合済み）ことを保証する。
//
// パターン: workflow-load-smoke.test.mjs と同スタイル（readFileSync + regex + node:test）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- (a) meta.phases の title 一覧と phase() 呼び出し出現順の一致検証 ----

test('meta.phases の title 一覧が実 phase() 呼び出し出現順と完全一致する（Security floor / Merge tier を含む）', () => {
  // meta.phases 配列から { title: 'X' } を抽出（コメント行は除外）
  const metaPhasesSection = src.match(/phases:\s*\[([\s\S]*?)\]/);
  assert.ok(metaPhasesSection, 'meta.phases 配列が見つからない');

  const phasesRaw = metaPhasesSection[1];
  // コメント行を除去してから title を抽出
  const phasesWithoutComments = phasesRaw.replace(/\/\/[^\n]*/g, '');
  const titleMatches = [...phasesWithoutComments.matchAll(/\{\s*title:\s*'([^']+)'\s*\}/g)];
  const metaTitles = titleMatches.map(m => m[1]);

  // 期待する完全な phase 一覧（出現順。issue #320 で Final reconcile を PR と Merge tier の間に追加）
  const expectedTitles = [
    'Setup',
    'Analyze',
    'Plan',
    'Implement',
    'Validate',
    'Security floor',
    'Evaluate',
    'PR',
    'Final reconcile',
    'Merge tier',
  ];

  assert.deepStrictEqual(
    metaTitles,
    expectedTitles,
    `meta.phases の title 一覧が期待値と異なる。実際: ${JSON.stringify(metaTitles)}`,
  );
});

test('phase() 呼び出し出現順が期待する phase 名の列と一致する', () => {
  // ソース中の phase('X') 呼び出しを出現順に抽出
  const phaseCallMatches = [...src.matchAll(/^phase\('([^']+)'\)/gm)];
  const phaseCallOrder = phaseCallMatches.map(m => m[1]);

  const expectedOrder = [
    'Setup',
    'Analyze',
    'Plan',
    'Implement',
    'Validate',
    'Security floor',
    'Evaluate',
    'PR',
    'Final reconcile',
    'Merge tier',
  ];

  assert.deepStrictEqual(
    phaseCallOrder,
    expectedOrder,
    `phase() 呼び出し順が期待値と異なる。実際: ${JSON.stringify(phaseCallOrder)}`,
  );
});

// ---- (b) label: 'diff-gate' と 'diff-gate-retry' が phase: 'Validate' を持つこと ----

test("label: 'diff-gate' を含む行が phase: 'Validate' を持つ", () => {
  const lines = src.split('\n');
  const diffGateLines = lines.filter(l => l.includes("label: 'diff-gate'"));
  assert.ok(diffGateLines.length > 0, "label: 'diff-gate' を含む行が見つからない");

  for (const line of diffGateLines) {
    assert.ok(
      line.includes("phase: 'Validate'"),
      `label: 'diff-gate' を含む行が phase: 'Validate' を持たない: ${line.trim()}`,
    );
  }
});

test("label: 'diff-gate-retry' を含む行が phase: 'Validate' を持つ", () => {
  const lines = src.split('\n');
  const diffGateRetryLines = lines.filter(l => l.includes("label: 'diff-gate-retry'"));
  assert.ok(diffGateRetryLines.length > 0, "label: 'diff-gate-retry' を含む行が見つからない");

  for (const line of diffGateRetryLines) {
    assert.ok(
      line.includes("phase: 'Validate'"),
      `label: 'diff-gate-retry' を含む行が phase: 'Validate' を持たない: ${line.trim()}`,
    );
  }
});

// ---- (c) error_category: 'empty_diff' の writeFailureTelemetry 呼び出しが phase: 'Validate' を持つ ----

test("error_category: 'empty_diff' の writeFailureTelemetry 呼び出しが phase: 'Validate' を持つ", () => {
  const lines = src.split('\n');
  const emptyDiffTelemetryLines = lines.filter(
    l => l.includes("error_category: 'empty_diff'") && l.includes('writeFailureTelemetry'),
  );
  assert.ok(
    emptyDiffTelemetryLines.length > 0,
    "error_category: 'empty_diff' を含む writeFailureTelemetry 呼び出しが見つからない",
  );

  for (const line of emptyDiffTelemetryLines) {
    assert.ok(
      line.includes("phase: 'Validate'"),
      `error_category: 'empty_diff' の writeFailureTelemetry が phase: 'Validate' を持たない: ${line.trim()}`,
    );
  }
});

// ---- (d) label: 'declared-path-check' がソースに存在しない（F3 porcelain 統合済み）----

test("label: 'declared-path-check' がソースに存在しない（F3 porcelain 統合済みで agent 呼び出し削除済み）", () => {
  // コメント行を除外した上で agent opts としての label: 'declared-path-check' 出現を確認
  const lines = src.split('\n');
  const labelDeclaredPathCheckLines = lines.filter(
    l => !l.trimStart().startsWith('//') && l.includes("label: 'declared-path-check'"),
  );

  assert.deepStrictEqual(
    labelDeclaredPathCheckLines,
    [],
    `label: 'declared-path-check' の agent 呼び出しがソースに存在する（F3 porcelain 統合で削除済みのはず）:\n${labelDeclaredPathCheckLines.join('\n')}`,
  );
});
