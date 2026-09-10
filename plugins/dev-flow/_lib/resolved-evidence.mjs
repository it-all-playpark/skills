// buildResolvedEvidence: 終端サマリーから件数表示に縮約される「解消済み証跡」の
// journal telemetry payload を組み立てる純関数。I/O なし、非決定性なし。
// 入力を mutate しない。同入力 -> 同出力。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// 1 フィールド（text / evidence）の初期上限文字数
export const RESOLVED_EVIDENCE_FIELD_CAP = 1000;
// JSON.stringify(result).length の上限
export const RESOLVED_EVIDENCE_MAX_CHARS = 16000;

/**
 * 値を文字列化し、上限 n 文字で切り詰める。null/undefined はそのまま null を返す。
 * @param {*} v
 * @param {number} n
 * @returns {{value: string|null, truncated: boolean}}
 */
function capText(v, n) {
  if (v == null) return { value: null, truncated: false };
  const s = String(v);
  if (s.length > n) {
    return { value: s.slice(0, n), truncated: true };
  }
  return { value: s, truncated: false };
}

/**
 * 4 配列（ledger_resolved / env_notes / ac_satisfied / security_cleared）を
 * cap 文字数 n で構築する。
 * @param {Array} blockArr
 * @param {Array} advArr
 * @param {Array} acArr
 * @param {number} n
 * @returns {{cap_chars: number, truncated: boolean, ledger_resolved: Array, env_notes: Array, ac_satisfied: Array, security_cleared: Array}}
 */
function buildAtCap(blockArr, advArr, acArr, n) {
  let truncated = false;

  const ledgerResolved = [];
  for (const it of blockArr) {
    if (it.checked !== true) continue;
    const text = capText(it.text, n);
    const evidence = capText(it.evidence, n);
    if (text.truncated || evidence.truncated) truncated = true;
    ledgerResolved.push({
      id: it.id,
      lane: 'blocking',
      dimension: it.dimension != null ? it.dimension : null,
      text: text.value,
      evidence: evidence.value,
    });
  }
  for (const it of advArr) {
    if (it.checked !== true) continue;
    if (it.escalate === true) continue;
    if (it.dimension === 'environment') continue;
    const text = capText(it.text, n);
    const evidence = capText(it.evidence, n);
    if (text.truncated || evidence.truncated) truncated = true;
    ledgerResolved.push({
      id: it.id,
      lane: 'advisory',
      dimension: it.dimension != null ? it.dimension : null,
      text: text.value,
      evidence: evidence.value,
    });
  }

  const envNotes = [];
  for (const it of advArr) {
    if (it.dimension !== 'environment') continue;
    const text = capText(it.text, n);
    const evidence = capText(it.evidence, n);
    if (text.truncated || evidence.truncated) truncated = true;
    envNotes.push({
      id: it.id,
      env_key: it.env_key != null ? it.env_key : null,
      env_count: typeof it.env_count === 'number' ? it.env_count : 1,
      checked: it.checked === true,
      text: text.value,
      evidence: evidence.value,
    });
  }

  const acSatisfied = [];
  for (const a of acArr) {
    if (!a || a.satisfied !== true) continue;
    const evidence = capText(a.evidence, n);
    if (evidence.truncated) truncated = true;
    acSatisfied.push({
      ac_index: a.ac_index,
      verified_by: a.verified_by != null ? a.verified_by : 'inspection',
      evidence: evidence.value,
    });
  }

  const securityCleared = [];
  for (const it of blockArr) {
    if (it.source !== 'seed' || it.dimension !== 'security' || it.floor !== true || it.checked !== true) continue;
    const evidence = capText(it.evidence, n);
    if (evidence.truncated) truncated = true;
    securityCleared.push({
      danger_class: it.danger_class,
      evidence: evidence.value,
    });
  }

  return {
    cap_chars: n,
    truncated,
    ledger_resolved: ledgerResolved,
    env_notes: envNotes,
    ac_satisfied: acSatisfied,
    security_cleared: securityCleared,
  };
}

/**
 * 終端サマリーの「解消済み証跡」journal telemetry payload を組み立てる。
 * 4 配列すべて空なら null を返す（呼び出し側はキー自体を省く）。
 * @param {object} opts
 * @param {Array} opts.blockingItems - ledger item 配列（{id,text,severity,checked,dimension,evidence,source,floor,danger_class,escalate,env_key,env_count}）
 * @param {Array} opts.advisoryItems - 同上
 * @param {Array<{ac_index,satisfied,evidence,verified_by}>|null|undefined} opts.acResults - AC 判定結果
 * @returns {object|null}
 */
export function buildResolvedEvidence({ blockingItems, advisoryItems, acResults }) {
  const blockArr = blockingItems || [];
  const advArr = advisoryItems || [];
  const acArr = acResults || [];

  let n = RESOLVED_EVIDENCE_FIELD_CAP;
  let result = buildAtCap(blockArr, advArr, acArr, n);

  while (JSON.stringify(result).length > RESOLVED_EVIDENCE_MAX_CHARS && n > 0) {
    n = Math.floor(n / 2);
    result = buildAtCap(blockArr, advArr, acArr, n);
  }

  if (
    result.ledger_resolved.length === 0 &&
    result.env_notes.length === 0 &&
    result.ac_satisfied.length === 0 &&
    result.security_cleared.length === 0
  ) {
    return null;
  }

  return result;
}
