// classifyShape: REQ オブジェクトから shape 判定を行う純粋関数。
// dev-flow の shape check に使用する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
export const SHAPE_RANK = { micro: 0, standard: 1, complex: 2 };

export function isBreakingText(s) {
  return /breaking|incompatible|migration|破壊的|非互換/i.test(String(s ?? ''));
}

function mergeShape(floor, llmShape) {
  if (!(llmShape in SHAPE_RANK)) {
    return floor;
  }
  return SHAPE_RANK[llmShape] > SHAPE_RANK[floor] ? llmShape : floor;
}

export function classifyShape(req) {
  const count = req.estimated_change_file_count;
  if (typeof count !== 'number' || count < 0) {
    const floor = 'complex';
    const reason = `estimated_change_file_count missing or invalid → safe floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  const ac = req.acceptance_criteria;
  if (!Array.isArray(ac)) {
    const floor = 'complex';
    const reason = `acceptance_criteria missing or not array → safe floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  const validTypes = ['feat', 'fix', 'docs', 'refactor'];
  if (!validTypes.includes(req.issue_type)) {
    const floor = 'complex';
    const reason = `issue_type '${req.issue_type}' not in allowed set → floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  const combined = `${req.scope ?? ''} ${req.summary ?? ''}`;
  if (isBreakingText(combined)) {
    const floor = 'complex';
    const reason = `breaking change detected in scope/summary → floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  let floor;
  if (count <= 2 && ac.length <= 3) {
    floor = 'micro';
  } else if (count <= 5 && ac.length <= 6) {
    floor = 'standard';
  } else {
    floor = 'complex';
  }

  const shape = mergeShape(floor, req.shape);
  let reason;
  if (shape !== floor) {
    reason = `LLM raised ${floor}→${shape}`;
  } else {
    reason = `estimated ${count} file(s), ${ac.length} AC, type=${req.issue_type} → floor=${floor}`;
  }
  return { shape, reason };
}

/**
 * refloorShape: realized diff のファイル数から shape を raise-only で調整する純粋関数。
 *
 * realized diff には AC 情報が無いため、file count のみで floor を引く
 * (classifyShape と同じ境界値 count<=2/count<=5 を使用)。
 * estimatedShape より大きい floor が得られた場合のみ上書きする (raise-only)。
 *
 * @param {string} estimatedShape - 計画時に決定した shape ('micro'|'standard'|'complex')
 * @param {number} realizedCount - realized diff の実ファイル数 (整数)
 * @returns {{ shape: string, refloored: boolean, realizedFloor: string, realizedCount: number }}
 */
export function refloorShape(estimatedShape, realizedCount) {
  let realizedFloor;
  if (typeof realizedCount !== 'number' || realizedCount < 0 || !Number.isFinite(realizedCount)) {
    realizedFloor = 'complex';
  } else if (realizedCount <= 2) {
    realizedFloor = 'micro';
  } else if (realizedCount <= 5) {
    realizedFloor = 'standard';
  } else {
    realizedFloor = 'complex';
  }

  const effective = SHAPE_RANK[realizedFloor] > SHAPE_RANK[estimatedShape] ? realizedFloor : estimatedShape;
  return {
    shape: effective,
    refloored: effective !== estimatedShape,
    realizedFloor,
    realizedCount,
  };
}
