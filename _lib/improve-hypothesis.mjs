// _lib/improve-hypothesis.mjs
// dev-improve の hypothesis ブロック（issue body 埋め込み）の build / parse / status 更新と
// metric enum。I/O なし・非決定性なし。verdict（confirmed/not_confirmed/insufficient_data）の
// 判定は dev-flow-improve/scripts/hypothesis-check.sh（決定論 oracle）が単一実装 —
// 本ファイルでは重複実装しない（軸A: LLM/orchestrator 側に効果判定を持たせない）。
// metric enum は hypothesis-check.sh の case 分岐と 1:1 対応を保つこと。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// 仮説 metric の閉じた enum。direction: 'lte' = target 以下で confirmed / 'gte' = target 以上で confirmed。
export const IMPROVE_METRIC_DIRECTIONS = Object.freeze({
  iterate_unhealthy_rate: 'lte',
  micro_share: 'gte',
  cap_pinned_count: 'lte',
});

export const HYPOTHESIS_BEGIN = '<!-- dev-improve:hypothesis:begin -->';
export const HYPOTHESIS_END = '<!-- dev-improve:hypothesis:end -->';
export const HYPOTHESIS_STATUSES = Object.freeze(['pending', 'confirmed', 'not_confirmed']);

export function improveMetricNames() {
  return Object.keys(IMPROVE_METRIC_DIRECTIONS);
}

// buildHypothesisBlock({metric, current, target, min_runs}) → markdown 文字列（status は常に pending）。
// out-of-enum metric / 非数値 / min_runs 非正整数は throw。
export function buildHypothesisBlock({ metric, current, target, min_runs }) {
  if (!IMPROVE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`improve-hypothesis: out-of-enum metric: ${JSON.stringify(metric ?? null)}`);
  }
  for (const [k, v] of [['current', current], ['target', target]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`improve-hypothesis: ${k} は有限数が必要です（受信: ${JSON.stringify(v)}）`);
    }
  }
  if (!Number.isInteger(min_runs) || min_runs < 1) {
    throw new Error(`improve-hypothesis: min_runs は正の整数が必要です（受信: ${JSON.stringify(min_runs)}）`);
  }
  return [
    HYPOTHESIS_BEGIN,
    '```yaml',
    `metric: ${metric}`,
    `current: ${current}`,
    `target: ${target}`,
    `min_runs: ${min_runs}`,
    'status: pending',
    '```',
    HYPOTHESIS_END,
  ].join('\n');
}

// parseHypothesisBlock(body) → {metric, current, target, min_runs, status} | null。
// マーカー不在は null（hypothesis 無し issue）。マーカーはあるが中身が不正なら throw
//（呼び出し側が per-issue try/catch で fail-open する）。
export function parseHypothesisBlock(body) {
  const src = String(body ?? '');
  const beginIdx = src.indexOf(HYPOTHESIS_BEGIN);
  if (beginIdx === -1) return null;
  const endIdx = src.indexOf(HYPOTHESIS_END, beginIdx);
  if (endIdx === -1) {
    throw new Error('improve-hypothesis: end マーカーがありません');
  }
  const zone = src.slice(beginIdx + HYPOTHESIS_BEGIN.length, endIdx);
  const fields = {};
  for (const line of zone.split('\n')) {
    const m = line.match(/^(metric|current|target|min_runs|status):\s*(\S+)\s*$/);
    if (m) fields[m[1]] = m[2];
  }
  const metric = fields.metric;
  if (!IMPROVE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`improve-hypothesis: out-of-enum metric: ${JSON.stringify(metric ?? null)}`);
  }
  const current = Number(fields.current);
  const target = Number(fields.target);
  const min_runs = Number(fields.min_runs);
  if (!Number.isFinite(current) || !Number.isFinite(target)
    || !Number.isInteger(min_runs) || min_runs < 1) {
    throw new Error('improve-hypothesis: current/target/min_runs が不正です');
  }
  if (!HYPOTHESIS_STATUSES.includes(fields.status)) {
    throw new Error(`improve-hypothesis: out-of-enum status: ${JSON.stringify(fields.status ?? null)}`);
  }
  return { metric, current, target, min_runs, status: fields.status };
}

// setHypothesisStatus(body, newStatus) → block 内の status 行のみ置換した body を返す。
// out-of-enum status / block 不在・不正 body は throw。
export function setHypothesisStatus(body, newStatus) {
  if (!HYPOTHESIS_STATUSES.includes(newStatus)) {
    throw new Error(`improve-hypothesis: out-of-enum status: ${JSON.stringify(newStatus)}`);
  }
  const parsed = parseHypothesisBlock(body);
  if (parsed == null) {
    throw new Error('improve-hypothesis: hypothesis ブロックが存在しません');
  }
  const src = String(body);
  const beginIdx = src.indexOf(HYPOTHESIS_BEGIN);
  const endIdx = src.indexOf(HYPOTHESIS_END, beginIdx);
  const zone = src.slice(beginIdx, endIdx);
  const newZone = zone.replace(/^status: .*$/m, `status: ${newStatus}`);
  return src.slice(0, beginIdx) + newZone + src.slice(endIdx);
}
