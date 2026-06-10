// dev-flow W5: gate_policy による lane 分類の純粋関数群。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// gate_policy の trust 昇順 4 値。
export const GATE_POLICIES = [
  'deterministic-only',
  'llm-major-advisory',
  'llm-major-blocking',
  'llm-autonomous',
];

// デフォルト gate_policy。
export const DEFAULT_GATE_POLICY = 'llm-major-advisory';

// gate_policy 値を解決する。null/undefined/空文字は DEFAULT_GATE_POLICY を返す。
// 有効値はそのまま返す。未知の値は Error を throw する。
export function resolveGatePolicy(value) {
  if (value == null || value === '') return DEFAULT_GATE_POLICY;
  if (GATE_POLICIES.includes(value)) return value;
  throw new Error(
    `gate-policy: 未知の gate_policy "${value}"（許可: ${GATE_POLICIES.join(', ')}）`,
  );
}

// item を 'blocking' | 'advisory' に分類する純粋関数。
//
// 軸A invariant（policy によらず常に blocking）:
//   - item.severity === 'critical'
//   - item.check && item.check.kind === 'deterministic'
//   - item.source === 'seed'
//
// LLM major（critical でなく deterministic でなく seed でない major）の写像:
//   deterministic-only  → advisory
//   llm-major-advisory  → advisory
//   llm-major-blocking  → blocking
//   llm-autonomous      → advisory
//
// LLM minor は全 policy で advisory。
export function gateLane(item, policy) {
  // 軸A invariant: 決定論 oracle / critical / seed は policy に依らず blocking
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  // LLM major の写像
  if (item.severity === 'major') {
    return policy === 'llm-major-blocking' ? 'blocking' : 'advisory';
  }
  // LLM minor（および未知 severity）は advisory
  return 'advisory';
}

// ledger.items のうち blocking に分類される item を返す純粋関数。
export function policyBlockingItems(ledger, policy) {
  return ledger.items.filter((it) => gateLane(it, policy) === 'blocking');
}

// ledger.items のうち advisory に分類される item を返す純粋関数。
export function policyAdvisoryItems(ledger, policy) {
  return ledger.items.filter((it) => gateLane(it, policy) === 'advisory');
}

// 全 blocking item が checked かどうかを判定する純粋関数（空は true）。
export function isConvergedUnderPolicy(ledger, policy) {
  return policyBlockingItems(ledger, policy).every((it) => it.checked);
}
