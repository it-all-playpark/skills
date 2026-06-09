// Goal Ledger: dev-flow の収束エンジン。収束 = BLOCKING lane の全項目 checked。
// item = { id, text, dimension, severity, source, checked, evidence, check, floor, reopen_reason }
//   severity: 'critical' | 'major' | 'minor'
//   source:   'ac' | 'seed' | 'reviewer' | 'evaluator' | 'danger-grep'
//   check:    { kind: 'deterministic' | 'inspection', ref?: string } | null
//   floor:    boolean  (true = 決定論 floor が注入。LLM は severity を lower できない)
//
// BLOCKING lane = 決定論 oracle 付き OR LLM critical OR seeded mandatory。それ以外は ADVISORY。
// 全関数は純粋(ledger を mutate せず新オブジェクトを返す)。state は呼び出し側の JS 変数に持つ。
//
// INLINE COPY POLICY: .claude/workflows/dev-flow.js は dynamic workflow ローダーが独自 VM で
// 評価し ESM import を使えないため、本モジュールの関数群を inline コピーしている。
// _lib/goal-ledger.sync.test.mjs がその byte 一致を CI で保証する。
// 本モジュールを修正する際は dev-flow.js の inline コピーも必ず同期すること。

const SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };

export function makeLedger() {
  return { items: [], round: 0 };
}

export function laneOf(item) {
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  return 'advisory';
}

export function topicKey(item) {
  const norm = String(item.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${item.dimension ?? '?'}::${norm}`;
}

export function canAppend(ledger, item) {
  if (ledger.round === 0) return true;
  if (item.severity === 'critical') return true;
  const key = topicKey(item);
  return ledger.items.some((it) => topicKey(it) === key);
}

export function appendItem(ledger, item) {
  if (!canAppend(ledger, item)) return { ledger, accepted: false };
  const key = topicKey(item);
  const idx = ledger.round > 0 ? ledger.items.findIndex((it) => topicKey(it) === key) : -1;
  const items = ledger.items.slice();
  if (idx >= 0) items[idx] = { ...items[idx], ...item, id: items[idx].id };
  else items.push({ checked: false, evidence: null, floor: false, check: null, ...item, check: item.check ? { ...item.check } : null });
  return { ledger: { ...ledger, items }, accepted: true };
}

export function applySeverityFloor(item, floorSeverity) {
  const raised = SEVERITY_RANK[floorSeverity] > SEVERITY_RANK[item.severity] ? floorSeverity : item.severity;
  return { ...item, severity: raised, floor: true };
}

export function mergeSeverity(item, llmSeverity) {
  if (item.floor && SEVERITY_RANK[llmSeverity] < SEVERITY_RANK[item.severity]) return item;
  const raised = SEVERITY_RANK[llmSeverity] > SEVERITY_RANK[item.severity] ? llmSeverity : item.severity;
  return { ...item, severity: raised };
}

export function checkItem(ledger, id, evidence) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: true, evidence: evidence ?? null };
  return { ...ledger, items };
}

export function reopenItem(ledger, id, reason) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  if (!reason) throw new Error('goal-ledger: reopen には reason が必要');
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: false, reopen_reason: reason };
  return { ...ledger, items };
}

export function setCheck(ledger, id, check) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], check };
  return { ...ledger, items };
}

export function blockingItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'blocking');
}

export function advisoryItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'advisory');
}

export function isConverged(ledger) {
  return blockingItems(ledger).every((it) => it.checked);
}

export function nextRound(ledger) {
  return { ...ledger, round: ledger.round + 1 };
}
