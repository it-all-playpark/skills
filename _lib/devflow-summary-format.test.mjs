import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevflowSummaryBody } from './devflow-summary-format.mjs';

// ─── 共通テストデータ ───────────────────────────────────────────────────────────

const BASE_INPUT = {
  pr: 42,
  mergeTier: 'REVIEW',
  mergeTierReasons: ['LLM judge advisory'],
  gatePolicy: 'llm-major-advisory',
  blockingItems: [],
  advisoryItems: [],
  ledgerConverged: true,
  acResults: undefined,
  securityClearance: undefined,
  planConcerns: [],
  dangerHits: [],
};

// ─── mergeTier ────────────────────────────────────────────────────────────────

test('mergeTier=HOLD -> 見出しに HOLD を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['danger hit detected'],
  });
  assert.ok(typeof body === 'string', 'string を返す');
  assert.ok(body.includes('HOLD'), 'HOLD を含む');
  assert.ok(body.includes('danger hit detected'), 'reason を含む');
});

test('mergeTier=REVIEW -> 見出しに REVIEW を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    mergeTierReasons: ['advisory item present'],
  });
  assert.ok(body.includes('REVIEW'), 'REVIEW を含む');
  assert.ok(body.includes('advisory item present'), 'reason を含む');
});

test('mergeTier=AUTO -> 見出しに AUTO を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'AUTO',
    mergeTierReasons: [],
  });
  assert.ok(body.includes('AUTO'), 'AUTO を含む');
});

test('mergeTierReasons が空の場合は「理由記載なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'AUTO',
    mergeTierReasons: [],
  });
  assert.ok(body.includes('理由記載なし'), 'reasons 空時の表示');
});

test('mergeTierReasons が複数件の場合はすべてを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['reason A', 'reason B', 'reason C'],
  });
  assert.ok(body.includes('reason A'), '1件目を含む');
  assert.ok(body.includes('reason B'), '2件目を含む');
  assert.ok(body.includes('reason C'), '3件目を含む');
});

// ─── Goal Ledger (blockingItems / advisoryItems) ──────────────────────────────

test('blockingItems / advisoryItems 0件 -> 「blocking item なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [],
    advisoryItems: [],
  });
  assert.ok(body.includes('blocking item なし'), 'blocking 空時の表示');
  // undefined が文字列に展開されていないこと
  assert.ok(!body.includes('undefined'), 'undefined が含まれない');
});

test('blockingItems 複数件 -> 各 id/text を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'security unresolved', severity: 'critical', checked: false, dimension: 'security' },
      { id: 'B2', text: 'AC unsatisfied', severity: 'major', checked: true, dimension: 'quality' },
    ],
  });
  assert.ok(body.includes('B1'), 'B1 id を含む');
  assert.ok(body.includes('security unresolved'), 'B1 text を含む');
  assert.ok(body.includes('B2'), 'B2 id を含む');
  assert.ok(body.includes('AC unsatisfied'), 'B2 text を含む');
});

test('blockingItems checked:true -> "checked" を表示', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'resolved item', severity: 'major', checked: true, dimension: 'quality' },
    ],
  });
  assert.ok(body.includes('checked'), 'checked ラベルを含む');
});

test('blockingItems checked:false -> "未解消" を表示', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unresolved item', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('未解消'), '未解消ラベルを含む');
});

test('advisoryItems 複数件 -> 各 id/text を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'style concern', severity: 'minor', checked: false, dimension: 'style', escalate: false },
      { id: 'A2', text: 'perf concern', severity: 'major', checked: false, dimension: 'perf', escalate: false },
    ],
  });
  assert.ok(body.includes('A1'), 'A1 id を含む');
  assert.ok(body.includes('style concern'), 'A1 text を含む');
  assert.ok(body.includes('A2'), 'A2 id を含む');
  assert.ok(body.includes('perf concern'), 'A2 text を含む');
});

test('advisoryItems escalate:true -> "(ESCALATE)" を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'urgent advisory', severity: 'major', checked: false, dimension: 'security', escalate: true },
    ],
  });
  assert.ok(body.includes('ESCALATE'), 'ESCALATE を含む');
});

test('advisoryItems escalate:false -> "(ESCALATE)" を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'normal advisory', severity: 'minor', checked: false, dimension: 'style', escalate: false },
    ],
  });
  assert.ok(!body.includes('ESCALATE'), 'ESCALATE を含まない');
});

test('gatePolicy と ledgerConverged を Goal Ledger セクションに含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    gatePolicy: 'llm-major-advisory',
    ledgerConverged: false,
  });
  assert.ok(body.includes('llm-major-advisory'), 'gatePolicy を含む');
  assert.ok(body.includes('未収束'), 'ledgerConverged false を示す');
});

test('ledgerConverged:true -> "済" を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    ledgerConverged: true,
  });
  assert.ok(body.includes('済'), 'converged 済を含む');
});

// ─── acResults ────────────────────────────────────────────────────────────────

test('acResults が undefined -> 例外を投げず「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: undefined,
  });
  assert.ok(body.includes('AC 判定なし'), 'AC 判定なし を含む');
  assert.ok(!body.includes('undefined'), 'undefined が含まれない');
});

test('acResults が null -> 「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: null,
  });
  assert.ok(body.includes('AC 判定なし'), 'AC 判定なし を含む');
});

test('acResults が空配列 -> 「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [],
  });
  assert.ok(body.includes('AC 判定なし'), '空配列時も AC 判定なし を含む');
});

test('acResults 複数件（satisfied true/false 混在）-> 各 AC index と evidence を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'test passed', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: false, evidence: 'test failed', verified_by: 'evaluator' },
      { ac_index: 2, satisfied: true, evidence: '', verified_by: undefined },
    ],
  });
  assert.ok(body.includes('AC#1'), 'AC#1 を含む (0-indexed+1)');
  assert.ok(body.includes('AC#2'), 'AC#2 を含む');
  assert.ok(body.includes('AC#3'), 'AC#3 を含む');
  assert.ok(body.includes('satisfied'), 'satisfied を含む');
  assert.ok(body.includes('未達'), '未達を含む');
  assert.ok(body.includes('test passed'), 'evidence を含む');
  assert.ok(body.includes('test failed'), 'evidence を含む');
  assert.ok(!body.includes('undefined'), 'undefined が含まれない');
});

test('acResults の verified_by が undefined -> デフォルト "inspection" を表示', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: undefined },
    ],
  });
  assert.ok(body.includes('inspection'), 'verified_by undefined -> inspection');
});

// ─── securityClearance ────────────────────────────────────────────────────────

test('securityClearance が undefined -> 「danger-grep clean」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    securityClearance: undefined,
  });
  assert.ok(body.includes('danger-grep clean'), 'clearance なし -> clean');
});

test('securityClearance が空配列 -> 「danger-grep clean」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    securityClearance: [],
  });
  assert.ok(body.includes('danger-grep clean'), '空配列 -> clean');
});

test('securityClearance 複数件（cleared true/false）-> danger_class と cleared 状態を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    securityClearance: [
      { danger_class: 'SQL_INJECTION', cleared: true, evidence: 'parameterized queries' },
      { danger_class: 'XSS', cleared: false, evidence: '' },
    ],
  });
  assert.ok(body.includes('SQL_INJECTION'), 'SQL_INJECTION を含む');
  assert.ok(body.includes('cleared'), 'cleared を含む');
  assert.ok(body.includes('XSS'), 'XSS を含む');
  assert.ok(body.includes('未確認'), '未確認を含む');
  assert.ok(!body.includes('undefined'), 'undefined が含まれない');
});

test('dangerHits があれば検出クラス情報を補足表示', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    dangerHits: ['SQL_INJECTION', 'PATH_TRAVERSAL'],
    securityClearance: [
      { danger_class: 'SQL_INJECTION', cleared: true, evidence: 'ok' },
    ],
  });
  assert.ok(body.includes('SQL_INJECTION'), 'dangerHits クラスを含む');
});

// ─── planConcerns ─────────────────────────────────────────────────────────────

test('planConcerns あり -> concern 文字列を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    planConcerns: ['concern A', 'concern B'],
  });
  assert.ok(body.includes('concern A'), 'concern A を含む');
  assert.ok(body.includes('concern B'), 'concern B を含む');
});

test('planConcerns 空 -> concern セクション見出しを含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    planConcerns: [],
  });
  assert.ok(!body.includes('Plan 未解消 concerns'), 'plan concerns 見出しを含まない');
});

// ─── 末尾マーカー ──────────────────────────────────────────────────────────────

test('末尾に安定マーカー <!-- dev-flow:TIER --> を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
  });
  assert.ok(body.includes('<!-- dev-flow:HOLD -->'), '安定マーカーを含む');
});

test('末尾に自動生成コメントを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
  });
  assert.ok(body.includes('dev-flow により自動生成'), '自動生成コメントを含む');
});

test('末尾に --- 区切り線を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
  });
  assert.ok(body.includes('---'), '区切り線を含む');
});

// ─── 見出し ────────────────────────────────────────────────────────────────────

test('見出しに PR 番号を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    pr: 99,
  });
  assert.ok(body.includes('PR #99'), 'PR 番号を含む');
});

// ─── 決定性 ───────────────────────────────────────────────────────────────────

test('決定性: 同入力 -> 2回呼んで byte 完全一致', () => {
  const input = {
    pr: 77,
    mergeTier: 'HOLD',
    mergeTierReasons: ['danger hit', 'security unresolved'],
    gatePolicy: 'llm-major-advisory',
    blockingItems: [
      { id: 'B1', text: 'critical issue', severity: 'critical', checked: false, dimension: 'security' },
    ],
    advisoryItems: [
      { id: 'A1', text: 'style', severity: 'minor', checked: false, dimension: 'style', escalate: false },
      { id: 'A2', text: 'perf', severity: 'major', checked: true, dimension: 'perf', escalate: true },
    ],
    ledgerConverged: false,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'passed', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: false, evidence: '', verified_by: undefined },
    ],
    securityClearance: [
      { danger_class: 'SQL_INJECTION', cleared: true, evidence: 'parameterized' },
    ],
    planConcerns: ['concern 1', 'concern 2'],
    dangerHits: ['SQL_INJECTION'],
  };
  const first = buildDevflowSummaryBody(input);
  const second = buildDevflowSummaryBody(input);
  assert.equal(first, second, '同入力 -> バイト完全一致');
});

// ─── 箇条書きスタイル ──────────────────────────────────────────────────────────

test('箇条書きは「- 」始まりで「・」を使わない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTierReasons: ['reason X'],
    blockingItems: [
      { id: 'B1', text: 'some item', severity: 'critical', checked: false, dimension: 'security' },
    ],
    advisoryItems: [
      { id: 'A1', text: 'advisory item', severity: 'minor', checked: false, dimension: 'style', escalate: false },
    ],
    planConcerns: ['plan concern'],
  });
  assert.ok(!body.includes('・'), '「・」を使わない');
  // 箇条書き行の存在確認
  const lines = body.split('\n');
  const bulletLines = lines.filter(l => l.trim().startsWith('- '));
  assert.ok(bulletLines.length > 0, '「- 」始まりの箇条書き行が存在する');
});
