// pr-iterate.js の review ステップへ多視点レビュー（2 レンズ並列 + adversarial verify）を
// 追加するための canonical。issue #418。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// 命名注記: stuckTopicKey は import せず自由識別子として参照する（同一ファイルに inline 済みの
// _lib/stuck-detector.mjs を workflow 側で共有するため — _lib/pr-comment-format.mjs が mdCell を
// 自由識別子として参照する precedent と同じ）。単体テストでは
// `globalThis.stuckTopicKey = stuckTopicKey` を注入すること。

// 2 レンズ定義（dimension を分割して 1 レンズあたりの報告範囲を絞る）。
export const MULTIREVIEW_LENSES = [
  { id: 'a', name: 'Correctness+Security', dimensions: ['Correctness', 'Security'] },
  { id: 'b', name: 'Testing+Maintainability+Performance', dimensions: ['Testing', 'Maintainability', 'Performance'] },
];

// _shared/references/stuck-topic-dictionary.md の Problem-Class Enum テーブル全 20 値（append-only）。
export const MULTIREVIEW_PROBLEM_CLASSES = [
  'scope-mismatch',
  'yagni-violation',
  'untestable-ac',
  'missing-file-reference',
  'wrong-file-target',
  'file-conflict-in-parallel',
  'dependency-contradiction',
  'self-containment-violation',
  'edge-case-unhandled',
  'error-handling-missing',
  'input-validation-missing',
  'security-vuln',
  'secret-exposure',
  'logic-bug',
  'regression',
  'test-missing',
  'test-weakening',
  'test-not-asserting',
  'performance-issue',
  'naming-convention',
];

const ZERO_WIDTH_RE = /[​‌‍﻿]/g;

// topic 文字列を stuck 検出突合可能な形へ正規化する。
// (a) string 以外・空 → ''
// (b) zero-width 文字除去 → trim
// (c) 最初の '::' より前（problem-class セグメント）を小文字化 + 空白/アンダースコアをハイフン化
//     '::' 以降の詳細 suffix は verbatim 保持（path の大小文字を壊さない）
export function normalizeReviewTopic(topic) {
  if (typeof topic !== 'string') return '';
  const cleaned = topic.replace(ZERO_WIDTH_RE, '').trim();
  if (!cleaned) return '';

  const sepIdx = cleaned.indexOf('::');
  if (sepIdx === -1) {
    return cleaned.toLowerCase().replace(/[\s_]+/g, '-');
  }
  const head = cleaned.slice(0, sepIdx);
  const tail = cleaned.slice(sepIdx + 2);
  const normHead = head.toLowerCase().replace(/[\s_]+/g, '-');
  return `${normHead}::${tail}`;
}

const SEVERITY_RANK = { critical: 3, major: 2, minor: 1 };

function truncateStr(v, max) {
  const s = String(v ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

// decision を issues から決定論導出する（critical/major あり→'request-changes'、
// minor のみ→'comment'、0 件→'approve'）。mergeLensReviews / applyAdversarialVerdicts で共有。
function deriveDecision(issues) {
  if (issues.some((x) => x.severity === 'critical' || x.severity === 'major')) return 'request-changes';
  if (issues.length > 0) return 'comment';
  return 'approve';
}

// 同一 dedup key で衝突した issue のうち保持する方を選ぶ:
//   1. severity が高い方（critical > major > minor）
//   2. 同 severity は file/line を両方持つ方を優先（file のみ < file+line）
//   3. なお同点なら既存（先に採用された方）を保持
function pickBetterIssue(existing, candidate) {
  const rankExisting = SEVERITY_RANK[existing.severity] ?? 0;
  const rankCandidate = SEVERITY_RANK[candidate.severity] ?? 0;
  if (rankCandidate > rankExisting) return candidate;
  if (rankExisting > rankCandidate) return existing;

  const scoreExisting = (existing.file != null ? 1 : 0) + (existing.line != null ? 1 : 0);
  const scoreCandidate = (candidate.file != null ? 1 : 0) + (candidate.line != null ? 1 : 0);
  if (scoreCandidate > scoreExisting) return candidate;
  return existing;
}

// [{lens, review}] を単一の REVIEW schema 互換オブジェクトへマージする。
// - topic は normalizeReviewTopic で正規化してから stuckTopicKey で dedup
// - description/suggestion/summary は REVIEW schema の maxLength に truncate
// - verification_evidence は各項目へ [lens-<id>] prefix を付け 120 字 truncate・最大 6 件
// - decision は deriveDecision で issues から決定論導出
export function mergeLensReviews(lensResults) {
  const list = Array.isArray(lensResults) ? lensResults : [];

  const merged = {};
  const mergeOrder = [];
  const lensIssueCounts = {};
  let mergedDupes = 0;

  for (const entry of list) {
    const lensId = entry?.lens?.id ?? (typeof entry?.lens === 'string' ? entry.lens : null);
    const issues = Array.isArray(entry?.review?.issues) ? entry.review.issues : [];
    if (lensId != null) lensIssueCounts[lensId] = issues.length;

    for (const issue of issues) {
      const candidate = { ...issue, topic: normalizeReviewTopic(issue?.topic) };
      const key = stuckTopicKey(candidate);
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        mergedDupes++;
        merged[key] = pickBetterIssue(merged[key], candidate);
      } else {
        merged[key] = candidate;
        mergeOrder.push(key);
      }
    }
  }

  const mergedIssues = mergeOrder.map((key) => {
    const issue = merged[key];
    const out = {
      severity: issue.severity,
      topic: issue.topic,
      file: issue.file,
      description: truncateStr(issue.description, 300),
      suggestion: truncateStr(issue.suggestion, 200),
    };
    if (issue.line != null) out.line = issue.line;
    return out;
  });

  const evidence = [];
  outer: for (const entry of list) {
    const lensId = entry?.lens?.id ?? (typeof entry?.lens === 'string' ? entry.lens : '?');
    const ev = Array.isArray(entry?.review?.verification_evidence) ? entry.review.verification_evidence : [];
    for (const e of ev) {
      if (evidence.length >= 6) break outer;
      evidence.push(truncateStr(`[lens-${lensId}] ${String(e)}`, 120));
    }
  }

  const summaries = list
    .map((entry) => entry?.review?.summary)
    .filter((s) => typeof s === 'string' && s.length > 0);
  const summary = truncateStr(summaries.join(' / '), 200);

  const review = {
    decision: deriveDecision(mergedIssues),
    issues: mergedIssues,
    summary,
    verification_evidence: evidence,
  };

  return { review, stats: { lens_issue_counts: lensIssueCounts, merged_dupes: mergedDupes } };
}

// adversarial verify の結果（[{index, verdict, reason}] または null/非配列）を review へ適用する。
// null/非配列 → fail-open（review 不変、dropped:0）。
// verdict==='rejected' の index の issue を除去し、除去後に decision を再導出する。
// 範囲外/非整数 index は無視する。
export function applyAdversarialVerdicts(review, verdicts) {
  if (!Array.isArray(verdicts)) {
    return { review, dropped: 0, fail_open: true };
  }

  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const rejected = new Set();
  for (const v of verdicts) {
    const idx = v?.index;
    if (!Number.isInteger(idx)) continue;
    if (idx < 0 || idx >= issues.length) continue;
    if (v?.verdict === 'rejected') rejected.add(idx);
  }

  if (rejected.size === 0) {
    return { review, dropped: 0, fail_open: false };
  }

  const keptIssues = issues.filter((_, i) => !rejected.has(i));
  const nextReview = { ...review, issues: keptIssues, decision: deriveDecision(keptIssues) };
  return { review: nextReview, dropped: rejected.size, fail_open: false };
}

// 1 レンズ分の review prompt を生成する純粋関数。
export function buildLensReviewPrompt({ pr, lens, prior }) {
  const dims = Array.isArray(lens?.dimensions) ? lens.dimensions.join('/') : '';
  const lines = [];
  lines.push(`PR #${pr} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。`);
  lines.push(`このレビューでは ${dims} の dimension のみ報告せよ（他 dimension は別レンズが担当）。`);
  lines.push(
    'topic は _shared/references/stuck-topic-dictionary.md の Problem-Class Enum に従え。'
    + '該当クラスがあれば必ず enum 値を使い、自由作文は禁止する。',
  );

  const prior_ = Array.isArray(prior) ? prior : [];
  if (prior_.length) {
    lines.push(
      `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior_)}\n`
      + '**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、'
      + '別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を'
      + '必ず再利用せよ（orchestrator が topic で stuck を突合する）。',
    );
  }

  return lines.join('\n');
}

// adversarial verify prompt を生成する純粋関数。
export function buildVerifyPrompt({ pr, issues }) {
  const list = Array.isArray(issues) ? issues : [];
  const enumerated = list
    .map((issue, i) => {
      const loc = issue.line != null ? `${issue.file}:${issue.line}` : `${issue.file}`;
      return `${i}. [${issue.severity}] ${issue.topic} — ${loc}: ${issue.description}`;
    })
    .join('\n');

  return `PR #${pr} の以下の findings を反証スタンスで検証せよ: 該当 file:line を実際に読み、`
    + '指摘が実在・再現可能か確認せよ。実在しない/誤読/PR スコープ外なら rejected、実在するなら confirmed とせよ。'
    + `index は列挙番号（0 始まり）を使え。\n\n${enumerated}`;
}

// AB 計測結果を ~/.claude/journal/ab-runs/ へ書き出す shell コマンドを生成する。
// buildJournalHandoffCommand（_lib/journal-handoff.mjs）と同構造。$(date +%s) は shell 側評価。
export function buildAbRecordCommand({ pr, mode, payload }) {
  const safePr = String(pr ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(safePr)) {
    throw new Error(`multireview: invalid pr: ${JSON.stringify(pr)}`);
  }
  if (mode !== 'single' && mode !== 'multi') {
    throw new Error(`multireview: invalid mode: ${JSON.stringify(mode)}`);
  }
  if (payload == null) throw new Error('multireview: payload is required');

  const AB_RUNS_DIR = '~/.claude/journal/ab-runs';
  const DELIM = 'AB_RUN_EOF';
  return `mkdir -p ${AB_RUNS_DIR} && cat > ${AB_RUNS_DIR}/result-${safePr}-${mode}-$(date +%s).json <<'${DELIM}'\n${String(payload)}\n${DELIM}`;
}
