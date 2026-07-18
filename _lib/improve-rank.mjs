// _lib/improve-rank.mjs
// dev-improve の候補 validate / dedup fingerprint / 決定論 rank / throughput cap +
// backpressure / issue body 生成。I/O なし・非決定性なし。
// LLM judge はスコア付けのみ — 最終順位・cut・棄却は本ファイルの決定論で行う
//（W7: cap は incentive-structural — ループに自分の提案量を自己増幅させない）。
// cross-canonical import 禁止のため metric enum は validateCandidate の引数で受ける。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const IMPROVE_MAX = 2;
export const IMPROVE_BACKPRESSURE_OPEN = 2;
export const IMPROVE_SOURCES = Object.freeze([
  'doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal', 'reconcile-revert',
]);
export const IMPROVE_RISKS = Object.freeze(['low', 'medium', 'high']);
// dev-flow 本体（自己改変）に該当する path prefix。触れる候補は canary AC を自動追記する。
export const IMPROVE_CORE_PREFIXES = Object.freeze([
  '.claude/workflows/', '_lib/', '.claude/agents/', 'tools/',
]);

// candidateKey(c): dedup 用の正規化 fingerprint。unicode 文字・数字以外を除去し lowercase。
export function candidateKey(c) {
  return String(c?.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// validateCandidate(c, metricNames): 共通 candidate schema の決定論バリデーション。
// evidence 空・AC 空・out-of-enum source/risk/metric・数値不正は false（棄却）。
export function validateCandidate(c, metricNames) {
  if (c == null || typeof c !== 'object') return false;
  if (!IMPROVE_SOURCES.includes(c.source)) return false;
  if (typeof c.title !== 'string' || !c.title.trim()) return false;
  if (!Array.isArray(c.evidence) || c.evidence.length === 0) return false;
  if (!c.evidence.every((e) => typeof e === 'string' && e.trim())) return false;
  if (!Array.isArray(c.acceptance_criteria) || c.acceptance_criteria.length === 0) return false;
  if (!c.acceptance_criteria.every((a) => typeof a === 'string' && a.trim())) return false;
  if (!IMPROVE_RISKS.includes(c.risk)) return false;
  const d = c.expected_metric_delta;
  if (d == null || typeof d !== 'object') return false;
  if (!Array.isArray(metricNames) || !metricNames.includes(d.metric)) return false;
  if (typeof d.current !== 'number' || !Number.isFinite(d.current)) return false;
  if (typeof d.target !== 'number' || !Number.isFinite(d.target)) return false;
  if (!Number.isInteger(d.min_runs) || d.min_runs < 1) return false;
  return true;
}

// rankCandidates(cands, scores): judge の {index, score} を突合し決定論順に整列した新配列を返す。
// score 降順 → risk 昇順（low < medium < high）→ candidateKey 昇順。score 不在 index は 0 扱い。
export function rankCandidates(cands, scores) {
  const scoreByIndex = {};
  for (const s of Array.isArray(scores) ? scores : []) {
    if (s != null && Number.isInteger(s.index) && typeof s.score === 'number' && Number.isFinite(s.score)) {
      scoreByIndex[s.index] = s.score;
    }
  }
  const riskOrder = { low: 0, medium: 1, high: 2 };
  return cands
    .map((c, i) => ({ c, score: scoreByIndex[i] ?? 0 }))
    .sort((a, b) => (b.score - a.score)
      || (riskOrder[a.c.risk] - riskOrder[b.c.risk])
      || (candidateKey(a.c) < candidateKey(b.c) ? -1 : candidateKey(a.c) > candidateKey(b.c) ? 1 : 0))
    .map((x) => x.c);
}

// selectTop(ranked, openImproveCount): backpressure + IMPROVE_MAX cut。
// openImproveCount が取得不能な場合は Infinity を渡す（fail-closed = backpressure 扱い）。
export function selectTop(ranked, openImproveCount) {
  if (Number(openImproveCount) >= IMPROVE_BACKPRESSURE_OPEN) {
    return { file: [], backlog: ranked.slice(), backpressure: true };
  }
  return { file: ranked.slice(0, IMPROVE_MAX), backlog: ranked.slice(IMPROVE_MAX), backpressure: false };
}

// buildImproveIssueBody(c, {hypothesisBlock}): 起票 issue body markdown を生成する。
// c.target_paths が IMPROVE_CORE_PREFIXES に触れる場合は canary AC（自己改変 floor）を自動追記。
export function buildImproveIssueBody(c, { hypothesisBlock }) {
  const lines = [];
  lines.push('## 背景');
  lines.push('');
  lines.push(`dev-improve サイクル（source: ${c.source}）が telemetry / PR シグナルから起票した自己改善 issue。`);
  if (typeof c.body_notes === 'string' && c.body_notes.trim()) {
    lines.push('');
    lines.push(c.body_notes.trim());
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const e of c.evidence) lines.push(`- ${e}`);
  lines.push('');
  lines.push('## 受け入れ条件');
  lines.push('');
  for (const a of c.acceptance_criteria) lines.push(`- [ ] ${a}`);
  const touchesCore = c.source === 'reconcile-revert'
    || (Array.isArray(c.target_paths)
      && c.target_paths.some((p) => IMPROVE_CORE_PREFIXES.some((pre) => String(p).startsWith(pre))));
  if (touchesCore) {
    lines.push('- [ ] PR 作成後に /dev-flow-canary を実行し、read-only capability canary が green であること（自己改変 floor）');
  }
  lines.push('');
  lines.push('## 効果検証仮説（dev-improve managed — 手動編集禁止）');
  lines.push('');
  lines.push(hypothesisBlock);
  lines.push('');
  lines.push('---');
  lines.push('*この issue は dev-improve（自己改善ループ）により自動起票されました。*');
  return lines.join('\n');
}

// buildBacklogSection({today, losers}): backlog issue へ追記する markdown セクション。
export function buildBacklogSection({ today, losers }) {
  const lines = [];
  lines.push(`### cycle ${today}`);
  lines.push('');
  for (const c of losers) {
    lines.push(`- [${c.source}] ${c.title}（risk: ${c.risk} / metric: ${c.expected_metric_delta.metric}）`);
  }
  return lines.join('\n');
}
