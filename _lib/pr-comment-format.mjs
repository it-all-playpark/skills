// buildReviewCommentBody / buildTerminalSummaryBody: pr-iterate の per-round
// レビューコメントおよび終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: .claude/workflows/pr-iterate.js は Claude Code の
// dynamic workflow ローダーが独自の VM コンテキストで評価するため、ESM の
// import 文（`import { buildReviewCommentBody } from '../../_lib/pr-comment-format.mjs'` 等）
// は使用できない。そのため pr-iterate.js に両関数の本体を inline コピーしており、
// _lib/pr-comment-format.sync.test.mjs がその byte 一致を CI で保証する。
// この関数を修正する際は、必ず pr-iterate.js の inline コピーも同期すること。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

export function mdCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * per-round レビューコメント markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {number} opts.iteration - 反復回数
 * @param {string} opts.decision - 'approve' | 'request-changes' | 'comment'
 * @param {Array} opts.blocking - blocking finding の配列
 * @returns {string}
 */
export function buildReviewCommentBody({ pr, iteration, decision, blocking }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
  const label = DECISION_LABEL[decision] ?? decision;
  const emoji = DECISION_EMOJI[decision] ?? '';
  const lines = [];

  lines.push(`## PR #${pr} — レビュー結果 (iteration ${iteration})`);
  lines.push('');

  const blockingList = blocking || [];
  if (blockingList.length === 0) {
    lines.push(`**判定**: ${emoji} ${label} — ✅ blocking 指摘なし`);
  } else {
    const c = blockingList.filter((f) => f.severity === 'critical').length;
    const m = blockingList.filter((f) => f.severity === 'major').length;
    lines.push(`**判定**: ${emoji} ${label} — blocking ${blockingList.length} 件（critical ${c} / major ${m}）`);
    lines.push('');
    lines.push('| # | 重大度 | 場所 | 指摘 | 提案 |');
    lines.push('|---|---|---|---|---|');
    let idx = 1;
    for (const f of blockingList) {
      const sev = SEV_LABEL[f.severity] ?? f.severity;
      const loc = f.file != null
        ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
        : '—';
      const desc = mdCell(f.description);
      const sug = f.suggestion != null ? mdCell(f.suggestion) : '—';
      lines.push(`| ${idx} | ${sev} | ${loc} | ${desc} | ${sug} |`);
      idx++;
    }
  }

  return lines.join('\n');
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
};

/**
 * 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.status - 'lgtm' | 'stuck' | 'fix_failed' | 'max_reached'
 * @param {number} opts.iterations - 総反復回数
 * @param {string} opts.lastDecision - 最終判定
 * @param {string} opts.lastSummary - 最終サマリーテキスト
 * @param {Array} opts.history - ラウンド履歴 [{iteration, decision, summary, blocking}]
 * @returns {string}
 */
export function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, history }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${STATUS_HEADLINE[status] ?? status}`);
  lines.push('');

  lines.push('| 終了状態 | 総反復 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision;
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  const histList = history || [];
  if (histList.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    lines.push('');
    lines.push('| iter | 判定 | blocking | summary |');
    lines.push('|---|---|---|---|');
    for (const round of histList) {
      const rEmoji = DECISION_EMOJI[round.decision] ?? '';
      const rLabel = DECISION_LABEL[round.decision] ?? round.decision;
      const bCount = (round.blocking ?? []).length;
      const rawSummary = mdCell(round.summary);
      const rSummary = rawSummary.length > 120 ? rawSummary.slice(0, 120) + '…' : rawSummary;
      lines.push(`| ${round.iteration} | ${rEmoji} ${rLabel} | ${bCount} | ${rSummary} |`);
    }
  }

  const allBlocking = histList.flatMap((r) => (r.blocking ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalBlocking = allBlocking.length;
  if (totalBlocking > 0) {
    lines.push('');
    lines.push(`<details><summary>全 blocking 指摘の詳細（${totalBlocking} 件）</summary>`);
    lines.push('');
    lines.push('| iter | 重大度 | 場所 | 指摘 | 提案 |');
    lines.push('|---|---|---|---|---|');
    for (const f of allBlocking) {
      const sev = SEV_LABEL[f.severity] ?? f.severity;
      const loc = f.file != null
        ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
        : '—';
      const desc = mdCell(f.description);
      const sug = f.suggestion != null ? mdCell(f.suggestion) : '—';
      lines.push(`| ${f.iter} | ${sev} | ${loc} | ${desc} | ${sug} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}
