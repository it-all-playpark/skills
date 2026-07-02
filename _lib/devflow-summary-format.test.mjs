import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdCell } from './md-cell.mjs';
import { buildDevflowSummaryBody } from './devflow-summary-format.mjs';

globalThis.mdCell = mdCell;

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
  shape: 'standard',
  testGreen: true,
  evalVerdict: 'pass',
};

// ─── at-a-glance テーブル絵文字 ──────────────────────────────────────────────

test('mergeTier=HOLD -> at-a-glance テーブルに🔶 **HOLD** を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['danger hit detected'],
  });
  assert.ok(body.includes('🔶 **HOLD**'), 'HOLD 絵文字を含む');
});

test('mergeTier=REVIEW -> at-a-glance テーブルに🔷 **REVIEW** を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
  });
  assert.ok(body.includes('🔷 **REVIEW**'), 'REVIEW 絵文字を含む');
});

test('mergeTier=AUTO -> at-a-glance テーブルに✅ **AUTO** を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'AUTO',
    mergeTierReasons: [],
  });
  assert.ok(body.includes('✅ **AUTO**'), 'AUTO 絵文字を含む');
});

test('at-a-glance テーブルにヘッダー行を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(body.includes('| Merge tier | shape | test | eval | Ledger | AC | danger |'), 'ヘッダー行を含む');
});

test('testGreen=true -> at-a-glance テーブルに「✅ green」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: true });
  assert.ok(body.includes('✅ green'), 'test green を含む');
});

test('testGreen=false -> at-a-glance テーブルに「❌ red」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: false });
  assert.ok(body.includes('❌ red'), 'test red を含む');
});

test('testGreen=null -> at-a-glance テーブルに「不明」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: null });
  assert.ok(body.includes('不明'), 'test 不明を含む');
});

test('evalVerdict=pass -> at-a-glance テーブルに「✅ pass」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, evalVerdict: 'pass' });
  assert.ok(body.includes('✅ pass'), 'eval pass を含む');
});

test('evalVerdict=fail -> at-a-glance テーブルに「❌ fail」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, evalVerdict: 'fail' });
  assert.ok(body.includes('❌ fail'), 'eval fail を含む');
});

test('evalVerdict=null -> at-a-glance テーブルに「不明」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, evalVerdict: null });
  assert.ok(body.includes('不明'), 'eval 不明を含む');
});

test('ledgerConverged=true -> at-a-glance テーブルに「✅ 収束」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, ledgerConverged: true });
  assert.ok(body.includes('✅ 収束'), 'ledger 収束を含む');
});

test('ledgerConverged=false -> at-a-glance テーブルに「⚠️ 未収束」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, ledgerConverged: false });
  assert.ok(body.includes('⚠️ 未収束'), 'ledger 未収束を含む');
});

test('dangerHits 2件 -> at-a-glance テーブルに「⚠️ 2 クラス」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    dangerHits: ['SQL_INJECTION', 'PATH_TRAVERSAL'],
  });
  assert.ok(body.includes('⚠️ 2 クラス'), 'danger 2クラスを含む');
});

test('dangerHits 0件 -> at-a-glance テーブルに「✅ clean」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, dangerHits: [] });
  assert.ok(body.includes('✅ clean'), 'danger clean を含む');
});

test('acResults 6件全 satisfied -> at-a-glance テーブルに「✅ 6/6」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok1', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'ok2', verified_by: 'evaluator' },
      { ac_index: 2, satisfied: true, evidence: 'ok3', verified_by: 'evaluator' },
      { ac_index: 3, satisfied: true, evidence: 'ok4', verified_by: 'evaluator' },
      { ac_index: 4, satisfied: true, evidence: 'ok5', verified_by: 'evaluator' },
      { ac_index: 5, satisfied: true, evidence: 'ok6', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('✅ 6/6'), 'AC 6/6 を含む');
});

test('acResults undefined -> at-a-glance テーブルに「—」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, acResults: undefined });
  assert.ok(body.includes('—'), 'AC — を含む');
});

// ─── gatePolicy ───────────────────────────────────────────────────────────────

test('gatePolicy 文字列が at-a-glance 直下行に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    gatePolicy: 'llm-major-advisory',
  });
  assert.ok(body.includes('`llm-major-advisory`'), 'gatePolicy バッククォートを含む');
  const lines = body.split('\n');
  const gatePolicyLineIdx = lines.findIndex(l => l.includes('gate_policy:') && l.includes('llm-major-advisory'));
  assert.ok(gatePolicyLineIdx >= 0, 'gate_policy 行を含む');
});

// ─── dangerHits 検出クラス ────────────────────────────────────────────────────

test('dangerHits 2件 -> 「検出クラス: SQL_INJECTION, PATH_TRAVERSAL」行を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    dangerHits: ['SQL_INJECTION', 'PATH_TRAVERSAL'],
  });
  assert.ok(body.includes('検出クラス: SQL_INJECTION, PATH_TRAVERSAL'), '検出クラス行を含む');
});

test('dangerHits 0件 -> 「検出クラス:」行を含まない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, dangerHits: [] });
  assert.ok(!body.includes('検出クラス:'), '検出クラス行を含まない');
});

// ─── Merge tier 理由 ──────────────────────────────────────────────────────────

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

test('Merge tier 理由セクションは常時可視（details 前）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    mergeTierReasons: ['advisory item present'],
    blockingItems: [
      { id: 'B1', text: 'check this', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  const detailsIdx = body.indexOf('<details>');
  const reasonIdx = body.indexOf('advisory item present');
  if (detailsIdx >= 0) {
    assert.ok(reasonIdx < detailsIdx, 'Merge tier 理由は details より前');
  } else {
    assert.ok(reasonIdx >= 0, 'Merge tier 理由を含む');
  }
});

// ─── 常時可視 invariant (AC-2) ────────────────────────────────────────────────

test('常時可視 invariant: unchecked blocking item が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unchecked blocking text', severity: 'critical', checked: false, dimension: 'security' },
    ],
    advisoryItems: [
      { id: 'A1', text: 'checked advisory', severity: 'minor', checked: true, dimension: 'style', escalate: false },
    ],
  });
  const detailsIdx = body.indexOf('<details>');
  const blockingIdx = body.indexOf('unchecked blocking text');
  assert.ok(blockingIdx >= 0, 'blocking text を含む');
  if (detailsIdx >= 0) {
    assert.ok(blockingIdx < detailsIdx, 'unchecked blocking が details より前');
  }
});

test('常時可視 invariant: 未達 AC が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'failed evidence', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'passed', verified_by: 'evaluator' },
    ],
  });
  const detailsIdx = body.indexOf('<details>');
  const failedIdx = body.indexOf('AC#1');
  assert.ok(failedIdx >= 0, '未達 AC を含む');
  if (detailsIdx >= 0) {
    assert.ok(failedIdx < detailsIdx, '未達 AC が details より前');
  }
});

test('常時可視 invariant: 未確認 clearance が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    securityClearance: [
      { danger_class: 'XSS', cleared: false, evidence: '' },
      { danger_class: 'SQL_INJECTION', cleared: true, evidence: 'ok' },
    ],
  });
  const detailsIdx = body.indexOf('<details>');
  const unclearedIdx = body.indexOf('XSS');
  assert.ok(unclearedIdx >= 0, '未確認 clearance を含む');
  if (detailsIdx >= 0) {
    assert.ok(unclearedIdx < detailsIdx, '未確認 clearance が details より前');
  }
});

test('常時可視 invariant: planConcerns が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    planConcerns: ['concern X'],
    blockingItems: [
      { id: 'B1', text: 'b', severity: 'critical', checked: true, dimension: 'sec' },
    ],
  });
  const detailsIdx = body.indexOf('<details>');
  const concernIdx = body.indexOf('concern X');
  assert.ok(concernIdx >= 0, 'concern を含む');
  if (detailsIdx >= 0) {
    assert.ok(concernIdx < detailsIdx, 'concern が details より前');
  }
});

// ─── 要対応セクション (AC-2) ──────────────────────────────────────────────────

test('要対応ゼロ -> 「### ✅ 要対応事項なし」を含み「### ⚠️ 要対応」を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'resolved', severity: 'major', checked: true, dimension: 'quality' },
    ],
    advisoryItems: [
      { id: 'A1', text: 'resolved advisory', severity: 'minor', checked: true, dimension: 'style', escalate: false },
    ],
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
    securityClearance: [
      { danger_class: 'SQL_INJECTION', cleared: true, evidence: 'safe' },
    ],
    planConcerns: [],
  });
  assert.ok(body.includes('### ✅ 要対応事項なし'), '要対応事項なしを含む');
  assert.ok(!body.includes('### ⚠️ 要対応'), '⚠️ 要対応を含まない');
});

test('unchecked blocking item あり -> 「### ⚠️ 要対応」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unresolved', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応を含む');
  assert.ok(!body.includes('### ✅ 要対応事項なし'), '要対応事項なしを含まない');
});

test('未達 AC あり -> 「### ⚠️ 要対応」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'fail', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応を含む');
});

test('escalate=true かつ checked=true の advisory item が要対応テーブルに出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated but checked', severity: 'major', checked: true, dimension: 'quality', escalate: true, escalate_reason: 'human needed' },
    ],
  });
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応を含む（escalate checked でも常時可視）');
  assert.ok(body.includes('advisory (ESCALATE)'), 'advisory (ESCALATE) lane を含む');
  const detailsIdx = body.indexOf('<details>');
  const escalateIdx = body.indexOf('escalated but checked');
  assert.ok(escalateIdx >= 0, 'escalate item text を含む');
  if (detailsIdx >= 0) {
    assert.ok(escalateIdx < detailsIdx, 'escalate item が details より前');
  }
});

test('ledger 未解消テーブルに「❌ 未解消」状態を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'blocking text', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('❌ 未解消'), '未解消状態を含む');
});

test('escalate=true checked=true -> テーブルに「⚠️ 要判断」状態を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated checked', severity: 'major', checked: true, dimension: 'quality', escalate: true },
    ],
  });
  assert.ok(body.includes('⚠️ 要判断'), '要判断状態を含む');
});

test('ledger テーブルに | 状態 | id | lane | dimension | 内容 | ヘッダーを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'check', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('| 状態 | id | lane | dimension | 内容 |'), 'ledger テーブルヘッダーを含む');
});

test('blocking item の lane が「blocking」', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'blocking item', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  const lines = body.split('\n');
  const itemLine = lines.find(l => l.includes('B1') && l.includes('blocking item'));
  assert.ok(itemLine, 'B1 行を含む');
  assert.ok(itemLine.includes('| blocking |'), 'blocking lane を含む');
});

test('advisory item の lane が「advisory」', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'advisory item', severity: 'minor', checked: false, dimension: 'style', escalate: false },
    ],
  });
  const lines = body.split('\n');
  const itemLine = lines.find(l => l.includes('A1') && l.includes('advisory item'));
  assert.ok(itemLine, 'A1 行を含む');
  assert.ok(itemLine.includes('| advisory |'), 'advisory lane を含む');
});

test('escalate advisory item の lane が「advisory (ESCALATE)」', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated advisory', severity: 'major', checked: false, dimension: 'quality', escalate: true },
    ],
  });
  const lines = body.split('\n');
  const itemLine = lines.find(l => l.includes('A1') && l.includes('escalated advisory'));
  assert.ok(itemLine, 'A1 行を含む');
  assert.ok(itemLine.includes('| advisory (ESCALATE) |'), 'advisory (ESCALATE) lane を含む');
});

test('ledger item に escalate_reason があれば「（reason: ...）」が後置される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated', severity: 'major', checked: false, dimension: 'quality', escalate: true, escalate_reason: 'needs human review' },
    ],
  });
  assert.ok(body.includes('（reason: needs human review）'), 'escalate_reason を含む');
});

test('未達 AC テーブルに | 状態 | AC | 検証 | evidence | ヘッダーを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'fail', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('| 状態 | AC | 検証 | evidence |'), 'AC テーブルヘッダーを含む');
});

test('未確認 clearance テーブルに | 状態 | danger class | evidence | ヘッダーを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    securityClearance: [
      { danger_class: 'XSS', cleared: false, evidence: '' },
    ],
  });
  assert.ok(body.includes('| 状態 | danger class | evidence |'), 'clearance テーブルヘッダーを含む');
});

// ─── エスケープ (AC-4) ────────────────────────────────────────────────────────

test('text に | を含む item でセルが \\\\| にエスケープされる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'text with | pipe', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('text with \\| pipe'), 'パイプがエスケープされる');
});

test('evidence に \\n を含む item でセルが <br> に変換される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'item', severity: 'critical', checked: false, dimension: 'security', evidence: 'line1\nline2' },
    ],
  });
  assert.ok(body.includes('line1<br>line2'), '改行が <br> に変換される');
});

// ─── 30 item + details 折りたたみ (AC-3) ─────────────────────────────────────

test('checked item 30件 + unchecked 1件 -> checked が details 内・unchecked が details 外', () => {
  const blockingItems = [];
  for (let i = 0; i < 30; i++) {
    blockingItems.push({
      id: `B${i + 1}`,
      text: `checked item ${i + 1}`,
      severity: 'major',
      checked: true,
      dimension: 'quality',
      evidence: `evidence ${i + 1}`,
    });
  }
  blockingItems.push({
    id: 'B31',
    text: 'unchecked item 31',
    severity: 'critical',
    checked: false,
    dimension: 'security',
  });

  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems,
  });

  const detailsIdx = body.indexOf('<details>');
  assert.ok(detailsIdx >= 0, '<details> を含む');

  // unchecked item は details より前
  const uncheckedIdx = body.indexOf('unchecked item 31');
  assert.ok(uncheckedIdx >= 0, 'unchecked item を含む');
  assert.ok(uncheckedIdx < detailsIdx, 'unchecked item が details より前');

  // details summary に 30件表示
  assert.ok(body.includes('✅ Goal Ledger 解消済み 30 件'), 'details summary に 30 件を含む');

  // checked item は details 以降にのみ出現
  for (let i = 0; i < 30; i++) {
    const id = `B${i + 1}`;
    const firstIdx = body.indexOf(`| ${id} |`);
    // checked items should only appear after <details>
    assert.ok(firstIdx > detailsIdx, `${id} が details 以降にのみ出現`);
  }
});

// ─── satisfied AC details (AC-3) ─────────────────────────────────────────────

test('acResults 6件全 satisfied -> details に「Acceptance Criteria 6/6 satisfied」summary を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok1', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'ok2', verified_by: 'evaluator' },
      { ac_index: 2, satisfied: true, evidence: 'ok3', verified_by: 'evaluator' },
      { ac_index: 3, satisfied: true, evidence: 'ok4', verified_by: 'evaluator' },
      { ac_index: 4, satisfied: true, evidence: 'ok5', verified_by: 'evaluator' },
      { ac_index: 5, satisfied: true, evidence: 'ok6', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('Acceptance Criteria 6/6 satisfied'), 'details summary を含む');
  // satisfied AC は details 内
  const detailsIdx = body.indexOf('<details>');
  assert.ok(detailsIdx >= 0, '<details> を含む');
});

// ─── securityClearance details (AC-3) ────────────────────────────────────────

test('securityClearance 未確認 1件 + cleared 6件 -> 未確認が details 外・cleared が details 内', () => {
  const securityClearance = [];
  for (let i = 0; i < 6; i++) {
    securityClearance.push({
      danger_class: `SAFE_CLASS_${i}`,
      cleared: true,
      evidence: `evidence ${i}`,
    });
  }
  securityClearance.push({
    danger_class: 'UNCLEARED_CLASS',
    cleared: false,
    evidence: '',
  });

  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    securityClearance,
    dangerHits: ['UNCLEARED_CLASS'],
  });

  const detailsIdx = body.indexOf('<details>');
  const unclearedIdx = body.indexOf('UNCLEARED_CLASS');
  assert.ok(unclearedIdx >= 0, '未確認クラスを含む');
  if (detailsIdx >= 0) {
    assert.ok(unclearedIdx < detailsIdx, '未確認が details より前');
  }
  assert.ok(body.includes('Security clearance 6/7 cleared'), 'clearance details summary を含む');
});

// ─── details 直後空行 (AC-3) ─────────────────────────────────────────────────

test('各 <summary> を含む行の直後が空行', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'resolved', severity: 'major', checked: true, dimension: 'quality' },
    ],
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
  });
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<summary>') && lines[i].includes('</summary>')) {
      assert.equal(lines[i + 1], '', `<summary> 行 ${i} の直後が空行`);
    }
  }
});

// ─── 空状態の常時可視行 ────────────────────────────────────────────────────────

test('blockingItems も advisoryItems も空 -> 「Goal Ledger: item なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [],
    advisoryItems: [],
  });
  assert.ok(body.includes('Goal Ledger: item なし'), 'Goal Ledger item なしを含む');
});

test('acResults undefined -> 「AC 判定なし（evaluator 未実行 or AC 欠落）」を常時可視領域に含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: undefined,
  });
  assert.ok(body.includes('AC 判定なし（evaluator 未実行 or AC 欠落）'), 'AC 判定なしを含む');
  const detailsIdx = body.indexOf('<details>');
  const acNoneIdx = body.indexOf('AC 判定なし');
  if (detailsIdx >= 0) {
    assert.ok(acNoneIdx < detailsIdx, 'AC 判定なしが details より前');
  }
});

test('acResults null -> 「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, acResults: null });
  assert.ok(body.includes('AC 判定なし'), 'AC 判定なしを含む');
});

test('acResults 空配列 -> 「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, acResults: [] });
  assert.ok(body.includes('AC 判定なし'), '空配列時も AC 判定なしを含む');
});

test('securityClearance undefined -> 「Security clearance: danger-grep clean（clearance 不要）」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, securityClearance: undefined });
  assert.ok(body.includes('Security clearance: danger-grep clean（clearance 不要）'), 'clearance clean を含む');
});

test('securityClearance 空配列 -> 「Security clearance: danger-grep clean（clearance 不要）」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, securityClearance: [] });
  assert.ok(body.includes('Security clearance: danger-grep clean（clearance 不要）'), '空配列 -> clean を含む');
});

// ─── 末尾マーカー (AC-5) ──────────────────────────────────────────────────────

test('末尾マーカーが /<!-- dev-flow:(HOLD|REVIEW|AUTO) -->$/ で末尾一致', () => {
  for (const tier of ['HOLD', 'REVIEW', 'AUTO']) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, mergeTier: tier, mergeTierReasons: [] });
    const pattern = new RegExp(`<!-- dev-flow:${tier} -->$`);
    assert.match(body, pattern, `${tier} のマーカーが末尾一致`);
  }
});

test('末尾に --- 区切り線を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(body.includes('---'), '区切り線を含む');
});

test('末尾に自動生成コメントを含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(body.includes('dev-flow により自動生成'), '自動生成コメントを含む');
});

// ─── 見出し ────────────────────────────────────────────────────────────────────

test('見出しに PR 番号を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, pr: 99 });
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
    shape: 'complex',
    testGreen: true,
    evalVerdict: 'pass',
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
    planConcerns: ['plan concern'],
  });
  assert.ok(!body.includes('・'), '「・」を使わない');
});

// ─── Plan concerns ────────────────────────────────────────────────────────────

test('planConcerns あり -> concern 文字列を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    planConcerns: ['concern A', 'concern B'],
  });
  assert.ok(body.includes('concern A'), 'concern A を含む');
  assert.ok(body.includes('concern B'), 'concern B を含む');
});

test('planConcerns 空 -> 「Plan 未解消 concerns」見出しを含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    planConcerns: [],
  });
  assert.ok(!body.includes('Plan 未解消 concerns'), 'plan concerns 見出しを含まない');
});

// ─── undefined が文字列に含まれない ──────────────────────────────────────────

test('undefined が文字列に展開されない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: undefined,
    securityClearance: undefined,
  });
  assert.ok(!body.includes('undefined'), 'undefined が含まれない');
});

// ─── shape ────────────────────────────────────────────────────────────────────

test('shape=complex -> at-a-glance テーブルに「complex」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, shape: 'complex' });
  assert.ok(body.includes('complex'), 'shape complex を含む');
});

test('shape=null -> at-a-glance テーブルに「不明」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, shape: null });
  assert.ok(body.includes('不明'), 'shape null -> 不明');
});

// ─── 旧形式のセクション見出しが出ない ────────────────────────────────────────

test('旧形式「### ESCALATE-TO-HUMAN（人間の判断が必要）」セクションが出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated', severity: 'major', checked: false, dimension: 'quality', escalate: true },
    ],
  });
  assert.ok(!body.includes('### ESCALATE-TO-HUMAN（人間の判断が必要）'), '旧 ESCALATE-TO-HUMAN 専用セクションが出ない');
});

test('旧形式「### 実行結果」セクションが出ない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!body.includes('### 実行結果'), '旧 実行結果セクションが出ない');
});

test('旧形式「### Goal Ledger」セクション見出しが出ない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!body.includes('### Goal Ledger'), '旧 Goal Ledger セクションが出ない');
});

test('旧形式「### Acceptance Criteria」セクション見出しが出ない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!body.includes('### Acceptance Criteria'), '旧 Acceptance Criteria セクションが出ない');
});

test('旧形式「### Security clearance」セクション見出しが出ない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!body.includes('### Security clearance'), '旧 Security clearance セクションが出ない');
});

// ─── 空状態行の直前行が空行であること (GFM テーブル・bullet 崩壊防止) ──────────

test('要対応テーブルあり + securityClearance 空 -> Security clearance 空状態行の直前行が空行', () => {
  // ケース(a): HOLD + danger clean の典型。unchecked blocking item あり（テーブル行末）、
  // acResults は非空（AC 空状態行は出ない）、securityClearance のみ空（clearance 空状態行が出る）。
  // 要対応テーブルの最終行（| ... |）直後に空行なしで空状態行が push されると
  // GFM がテーブル行として吸収し壊れる。直前行が空行であることを assert する。
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['blocking item unresolved'],
    blockingItems: [
      { id: 'B1', text: 'unresolved item', severity: 'critical', checked: false, dimension: 'security' },
    ],
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
    securityClearance: undefined,
  });
  const lines = body.split('\n');
  const secIdx = lines.findIndex(l => l.includes('Security clearance: danger-grep clean'));
  assert.ok(secIdx >= 0, 'Security clearance 空状態行が存在する');
  assert.equal(lines[secIdx - 1], '', `Security clearance 空状態行の直前行（index ${secIdx - 1}）が空行`);
});

test('planConcerns あり + acResults 空 -> AC 空状態行の直前行が空行', () => {
  // ケース(b): planConcerns が要対応セクションの最後の場合。
  // blockingItems は非空（Goal Ledger 空状態行は出ない）、securityClearance は非空（clearance 空状態行は出ない）。
  // "- concern A" 直後に空行なしで AC 空状態行が push されると
  // GFM の lazy continuation で bullet 内に視覚的に併合される。
  // 直前行が空行であることを assert する。
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unresolved', severity: 'critical', checked: false, dimension: 'security' },
    ],
    planConcerns: ['concern A'],
    acResults: undefined,
    securityClearance: [{ danger_class: 'SQL_INJECTION', cleared: true, evidence: 'ok' }],
  });
  const lines = body.split('\n');
  const acIdx = lines.findIndex(l => l.includes('Acceptance Criteria: AC 判定なし'));
  assert.ok(acIdx >= 0, 'AC 空状態行が存在する');
  assert.equal(lines[acIdx - 1], '', `AC 空状態行の直前行（index ${acIdx - 1}）が空行`);
});

// ─── evalTreeStale 警告 (issue #215) ─────────────────────────────────────────

test('evalTreeStale=true -> 本文に「Evaluate は古い tree に対して実行された」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalTreeStale: true,
  });
  assert.ok(body.includes('Evaluate は古い tree に対して実行された'), 'stale 警告文字列を含む');
});

test('evalTreeStale=true -> 警告行が gate_policy: 行より前、at-a-glance テーブルより後に位置する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalTreeStale: true,
  });
  const lines = body.split('\n');
  const tableRowIdx = lines.findIndex(l => l.startsWith('| ') && l.includes('\u{1F537} **REVIEW**'));
  const warnIdx = lines.findIndex(l => l.includes('Evaluate は古い tree に対して実行された'));
  const gatePolicyIdx = lines.findIndex(l => l.startsWith('gate_policy:'));
  assert.ok(tableRowIdx >= 0, 'at-a-glance テーブル行が存在する');
  assert.ok(warnIdx >= 0, '警告行が存在する');
  assert.ok(gatePolicyIdx >= 0, 'gate_policy 行が存在する');
  assert.ok(warnIdx > tableRowIdx, '警告はテーブル行より後');
  assert.ok(warnIdx < gatePolicyIdx, '警告は gate_policy 行より前');
});

test('evalTreeStale=false -> 警告文字列を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalTreeStale: false,
  });
  assert.ok(!body.includes('Evaluate は古い tree に対して実行された'), 'false 時は警告を含まない');
});

test('evalTreeStale 未指定 -> 警告文字列を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
  });
  assert.ok(!body.includes('Evaluate は古い tree に対して実行された'), '未指定時は警告を含まない');
});

test('evalTreeStale=true -> テーブル最終行と警告の間に空行があり GFM テーブルが壊れない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalTreeStale: true,
  });
  const lines = body.split('\n');
  // at-a-glance テーブルの最終データ行（| tier | shape | ... | の行）を探す
  const tableDataIdx = lines.findIndex(l => l.startsWith('| ') && l.includes('\u{1F537} **REVIEW**'));
  assert.ok(tableDataIdx >= 0, 'テーブルデータ行が存在する');
  // その直後の行が空行であること
  assert.equal(lines[tableDataIdx + 1], '', `テーブル最終行（index ${tableDataIdx}）の直後行（index ${tableDataIdx + 1}）が空行`);
});

// ─── ui-verify 結果表示 (issue #285) ─────────────────────────────────────────

test('uiVerify=findings, uiVerifyMode=scenario -> ui-verify 結果行が出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    uiVerify: 'findings',
    uiVerifyMode: 'scenario',
  });
  assert.ok(body.includes('- UI 検証 (ui-verify): findings (mode: scenario)'), 'ui-verify 結果行を含む');
});

test('uiVerify=skipped -> 本文に「ui-verify」文字列を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    uiVerify: 'skipped',
    uiVerifyMode: null,
  });
  assert.ok(!body.includes('ui-verify'), 'skipped 時は ui-verify 行を出さない');
});

test('uiVerify 未指定（既存呼び出し互換） -> 本文に「ui-verify」文字列を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
  });
  assert.ok(!body.includes('ui-verify'), '未指定時は ui-verify 行を出さない');
});

test('uiVerify=failed_open, uiVerifyMode=null -> mode 括弧が付かない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    uiVerify: 'failed_open',
    uiVerifyMode: null,
  });
  assert.ok(body.includes('- UI 検証 (ui-verify): failed_open'), 'ui-verify 結果行を含む');
  assert.ok(!body.includes('mode:'), 'mode 括弧を含まない');
});
