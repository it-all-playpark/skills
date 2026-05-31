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
  const label = DECISION_LABEL[decision] ?? decision;
  const lines = [];

  lines.push(`## PR #${pr} — レビュー結果 (iteration ${iteration})`);
  lines.push('');
  lines.push(`**判定**: ${label}`);
  lines.push('');
  lines.push('### Blocking 指摘');

  if (!blocking || blocking.length === 0) {
    lines.push('blocking 指摘なし');
  } else {
    for (const f of blocking) {
      const loc = f.file != null
        ? `${f.file}${f.line != null ? ':' + f.line : ''} `
        : '';
      const sug = f.suggestion != null ? ` → ${f.suggestion}` : '';
      lines.push(`- [${f.severity}] ${loc}${f.description}${sug}`);
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
  const headline = STATUS_HEADLINE[status] ?? status;
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${headline}`);
  lines.push('');
  lines.push(`- **総反復回数**: ${iterations}`);
  lines.push(`- **最終判定**: ${DECISION_LABEL[lastDecision] ?? lastDecision}`);
  lines.push(`- **最終判定理由**: ${lastSummary}`);

  if (history && history.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    for (const round of history) {
      const roundLabel = DECISION_LABEL[round.decision] ?? round.decision;
      lines.push('');
      lines.push(`#### Iteration ${round.iteration}: ${roundLabel}`);
      lines.push(`${round.summary}`);
      if (round.blocking && round.blocking.length > 0) {
        lines.push(`- blocking 指摘数: ${round.blocking.length}`);
        for (const f of round.blocking) {
          const loc = f.file != null
            ? `${f.file}${f.line != null ? ':' + f.line : ''} `
            : '';
          const sug = f.suggestion != null ? ` → ${f.suggestion}` : '';
          lines.push(`  - [${f.severity}] ${loc}${f.description}${sug}`);
        }
      } else {
        lines.push('- blocking 指摘なし');
      }
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}
