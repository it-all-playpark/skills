// issue #611: planConcerns の summary フィルタが merge tier に波及しないことを pin する。
// merge tier は planConcerns を入力に持たない設計であり、これを崩す変更は本テストを赤にする。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyMergeTier } from './merge-tier.mjs';
import { buildDevflowSummaryBody } from './devflow-summary-format.mjs';
import { mdCell } from './md-cell.mjs';

globalThis.mdCell = mdCell;

const here = dirname(fileURLToPath(import.meta.url));

// REVIEW 相当 base（standard、他条件クリーン）
function standardBase() {
  return {
    shape: 'standard',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: false,
    escalateCount: 0,
    iterateStatus: 'lgtm',
    evalStaleness: 'none',
  };
}

// HOLD 相当 base（standardBase + converged:false）
function holdBase() {
  return { ...standardBase(), converged: false };
}

// AUTO 適格 base（micro + docs/test-only + danger clean + 収束）
function autoBase() {
  return {
    shape: 'micro',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: true,
    escalateCount: 0,
    iterateStatus: 'lgtm',
    evalStaleness: 'none',
  };
}

// ─── 1. 動的 pin: classifyMergeTier は planConcerns を無視する ───────────────

test('classifyMergeTier: standardBase → REVIEW を実際に踏み、planConcerns の有無で結果不変', () => {
  const base = standardBase();
  const without = classifyMergeTier(base);
  const withConcerns = classifyMergeTier({ ...base, planConcerns: ['[plan:major] x: y'] });
  assert.equal(without.tier, 'REVIEW');
  assert.deepEqual(withConcerns, without);
});

test('classifyMergeTier: holdBase → HOLD を実際に踏み、planConcerns の有無で結果不変', () => {
  const base = holdBase();
  const without = classifyMergeTier(base);
  const withConcerns = classifyMergeTier({ ...base, planConcerns: ['[plan:major] x: y'] });
  assert.equal(without.tier, 'HOLD');
  assert.deepEqual(withConcerns, without);
});

test('classifyMergeTier: autoBase → AUTO を実際に踏み、planConcerns の有無で結果不変', () => {
  const base = autoBase();
  const without = classifyMergeTier(base);
  const withConcerns = classifyMergeTier({ ...base, planConcerns: ['[plan:major] x: y'] });
  assert.equal(without.tier, 'AUTO');
  assert.deepEqual(withConcerns, without);
});

// ─── 2. 静的 pin: merge-tier.mjs ソースに planConcerns が出現しない ─────────

test('静的 pin: merge-tier.mjs ソースに "planConcerns" 文字列が出現しない', () => {
  const src = readFileSync(join(here, 'merge-tier.mjs'), 'utf8');
  assert.ok(!src.includes('planConcerns'), 'merge-tier.mjs は planConcerns を参照してはならない');
});

// ─── 3. 静的 pin: dev-flow.js の classifyMergeTier 呼び出しブロックに planConcerns が無く、
//        tier 確定（classifyMergeTier 呼び出し）が summary 描画（buildDevflowSummaryBody 呼び出し）より前 ───

test('静的 pin: dev-flow.js の classifyMergeTier({...}) 呼び出しブロックに planConcerns が出現せず、buildDevflowSummaryBody 呼び出しより前に位置する', () => {
  const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

  const mergeTierCallMarker = 'const mergeTier = classifyMergeTier({';
  const summaryCallMarker = 'const summaryBody = buildDevflowSummaryBody({';

  const mergeTierIdx = src.indexOf(mergeTierCallMarker);
  const summaryIdx = src.indexOf(summaryCallMarker);

  assert.ok(mergeTierIdx >= 0, 'dev-flow.js に classifyMergeTier 呼び出しが見つかるべき');
  assert.ok(summaryIdx >= 0, 'dev-flow.js に buildDevflowSummaryBody 呼び出しが見つかるべき');
  assert.ok(mergeTierIdx < summaryIdx, 'classifyMergeTier 呼び出しは buildDevflowSummaryBody 呼び出しより前に位置するべき（tier 確定後に summary を描画する順序）');

  const closeIdx = src.indexOf('})', mergeTierIdx + mergeTierCallMarker.length);
  assert.ok(closeIdx >= 0, 'classifyMergeTier 呼び出しブロックの閉じ "})" が見つかるべき');

  const callBlock = src.slice(mergeTierIdx, closeIdx);
  assert.ok(!callBlock.includes('planConcerns'), 'dev-flow.js の classifyMergeTier({...}) 呼び出しブロックに planConcerns を渡してはならない');
});

// ─── 4. summary 表示側 pin: tier 行・marker は planConcerns の有無で不変 ────

const SUMMARY_BASE_INPUT = {
  pr: 42,
  mergeTier: 'HOLD',
  mergeTierReasons: ['ledger 未収束（未 checked blocking 残）'],
  gatePolicy: 'llm-major-advisory',
  blockingItems: [],
  advisoryItems: [{
    id: 'CONCERN-1',
    text: '[plan:major] t: d',
    dimension: 'concern',
    severity: 'major',
    source: 'concern',
    checked: true,
    evidence: 'concern resolved: ok',
  }],
  ledgerConverged: false,
  acResults: undefined,
  dangerHits: [],
  shape: 'standard',
  testGreen: true,
  evalVerdict: 'pass',
};

function tierLine(body, tier) {
  return body.split('\n').find((l) => l.includes(`**${tier}**`));
}

test('summary 表示側 pin: mergeTier=HOLD で planConcerns の有無に関わらず tier 行・marker が一致する', () => {
  const bodyWithout = buildDevflowSummaryBody({ ...SUMMARY_BASE_INPUT, planConcerns: [] });
  const bodyWith = buildDevflowSummaryBody({ ...SUMMARY_BASE_INPUT, planConcerns: ['[plan:major] t: d'] });

  assert.ok(bodyWithout.includes('**HOLD**'), 'planConcerns なしでも **HOLD** を含む');
  assert.ok(bodyWith.includes('**HOLD**'), 'planConcerns ありでも **HOLD** を含む');
  assert.ok(bodyWithout.includes('<!-- dev-flow:HOLD -->'), 'planConcerns なしでも HOLD marker を含む');
  assert.ok(bodyWith.includes('<!-- dev-flow:HOLD -->'), 'planConcerns ありでも HOLD marker を含む');

  assert.ok(bodyWithout.includes('ledger 未収束（未 checked blocking 残）'), 'planConcerns なしでも理由文字列を含む');
  assert.ok(bodyWith.includes('ledger 未収束（未 checked blocking 残）'), 'planConcerns ありでも理由文字列を含む');

  const lineWithout = tierLine(bodyWithout, 'HOLD');
  const lineWith = tierLine(bodyWith, 'HOLD');
  assert.ok(lineWithout, 'planConcerns なしの tier 行が見つかるべき');
  assert.equal(lineWith, lineWithout, 'tier 行は planConcerns の有無で不変であるべき');
});

test('summary 表示側 pin: mergeTier=REVIEW で planConcerns の有無に関わらず tier 行・marker が一致する', () => {
  const reviewInput = { ...SUMMARY_BASE_INPUT, mergeTier: 'REVIEW', mergeTierReasons: ['標準 — 人間が LGTM して merge'] };
  const bodyWithout = buildDevflowSummaryBody({ ...reviewInput, planConcerns: [] });
  const bodyWith = buildDevflowSummaryBody({ ...reviewInput, planConcerns: ['[plan:major] t: d'] });

  assert.ok(bodyWithout.includes('**REVIEW**'), 'planConcerns なしでも **REVIEW** を含む');
  assert.ok(bodyWith.includes('**REVIEW**'), 'planConcerns ありでも **REVIEW** を含む');
  assert.ok(bodyWithout.includes('<!-- dev-flow:REVIEW -->'), 'planConcerns なしでも REVIEW marker を含む');
  assert.ok(bodyWith.includes('<!-- dev-flow:REVIEW -->'), 'planConcerns ありでも REVIEW marker を含む');

  const lineWithout = tierLine(bodyWithout, 'REVIEW');
  const lineWith = tierLine(bodyWith, 'REVIEW');
  assert.ok(lineWithout, 'planConcerns なしの tier 行が見つかるべき');
  assert.equal(lineWith, lineWithout, 'tier 行は planConcerns の有無で不変であるべき');
});
