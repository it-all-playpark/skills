// buildReviewCommentBody / buildTerminalSummaryBody: pr-iterate の per-round
// レビューコメントおよび終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };

/**
 * finding 配列を番号付き箇条書き markdown 行配列へ変換する。
 * 1 finding = 見出し行（severity + 場所）+ `指摘` 行 + （suggestion があれば）`提案` 行。
 * @param {Array} list - finding 配列（severity, file, line, description, suggestion, 任意で iter）
 * @param {object} [opts]
 * @param {boolean} [opts.withIter] - true の場合、見出し行末尾に `（反復 N 回目）` を付与する
 * @returns {string[]}
 */
function formatFindingsList(list, { withIter = false } = {}) {
  const out = [];
  let idx = 1;
  for (const f of list) {
    const sev = SEV_LABEL[f.severity] ?? f.severity;
    const loc = f.file != null
      ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
      : '場所指定なし';
    const iterSuffix = withIter ? `（反復 ${f.iter} 回目）` : '';
    out.push(`${idx}. ${sev} — ${loc}${iterSuffix}`);
    out.push(`   - 指摘: ${mdCell(f.description)}`);
    if (f.suggestion != null) {
      out.push(`   - 提案: ${mdCell(f.suggestion)}`);
    }
    idx++;
  }
  return out;
}

/**
 * per-round レビューコメント markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {number} opts.iteration - 反復回数
 * @param {string} opts.decision - 'approve' | 'request-changes' | 'comment'
 * @param {Array} opts.blocking - blocking finding の配列
 * @param {Array} [opts.minor] - minor finding の配列（fix loop 対象外・参考表示のみ、任意）
 * @param {string} [opts.summary] - 結論 1-2 文（任意）
 * @param {string[]} [opts.verificationEvidence] - 検証根拠リスト（任意）
 * @returns {string}
 */
export function buildReviewCommentBody({ pr, iteration, decision, blocking, minor, summary, verificationEvidence }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const label = DECISION_LABEL[decision] ?? decision;
  const emoji = DECISION_EMOJI[decision] ?? '';
  const lines = [];

  lines.push(`## PR #${pr} — レビュー結果 (iteration ${iteration})`);
  lines.push('');

  const blockingList = blocking || [];
  if (blockingList.length === 0) {
    lines.push(`**判定**: ${emoji} ${label} — ✅ 要修正（blocking）の指摘なし`);
  } else {
    const c = blockingList.filter((f) => f.severity === 'critical').length;
    const m = blockingList.filter((f) => f.severity === 'major').length;
    lines.push(`**判定**: ${emoji} ${label} — 要修正（blocking）${blockingList.length} 件（critical ${c} / major ${m}）`);
    lines.push('');
    lines.push(...formatFindingsList(blockingList));
  }

  const minorList = minor || [];
  if (minorList.length > 0) {
    lines.push('');
    lines.push(`**軽微な指摘（minor、自動修正対象外・参考）**: ${minorList.length} 件`);
    lines.push('');
    lines.push('<details><summary>詳細を表示</summary>');
    lines.push('');
    lines.push(...formatFindingsList(minorList));
    lines.push('');
    lines.push('</details>');
  }

  if (summary != null && summary !== '') {
    lines.push('');
    lines.push(`**総評**: ${summary}`);
  }
  const evList = verificationEvidence || [];
  if (evList.length > 0) {
    lines.push('');
    lines.push('**検証根拠**:');
    for (const e of evList) lines.push(`- ${mdCell(e)}`);
  }

  return lines.join('\n');
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
  'ci_error': '⚠️ CI エラー — gh API 失敗（auth/network）。人間へエスカレーション',
  'ci_pending': '⏳ CI 未完了 — checks pending。人間/CI 完了待ちへエスカレーション',
  'review_contract_error': '⚠️ REVIEW CONTRACT ERROR — reviewer の decision と blocking findings の矛盾が再 review 後も再発。人間へエスカレーション',
};

/**
 * 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.status - 'lgtm' | 'stuck' | 'fix_failed' | 'max_reached' | 'ci_error' | 'ci_pending' | 'review_contract_error'
 * @param {number} opts.iterations - 総反復回数
 * @param {string} opts.lastDecision - 最終判定
 * @param {string} opts.lastSummary - 最終サマリーテキスト
 * @param {string[]} [opts.lastVerificationEvidence] - 最終検証根拠リスト（任意）
 * @param {Array} opts.history - ラウンド履歴 [{iteration, decision, summary, blocking, minor}]
 * @param {number} [opts.ciWaitSeconds] - CI pending 待機の累積秒数（任意。check-ci.sh --wait-seconds ポーリング分）
 * @param {number} [opts.ciPollAttempts] - CI ステータス取得の累積ポーリング回数（任意）
 * @returns {string}
 */
export function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, lastVerificationEvidence, history, ciWaitSeconds, ciPollAttempts }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${STATUS_HEADLINE[status] ?? status}`);
  lines.push('');

  lines.push('| 終了状態 | 反復回数 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision;
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  if (ciWaitSeconds != null || ciPollAttempts != null) {
    lines.push('');
    lines.push(`**CI 待機**: ${ciWaitSeconds ?? 0}秒（ポーリング ${ciPollAttempts ?? 0} 回）`);
  }

  const evList2 = lastVerificationEvidence || [];
  if (evList2.length > 0) {
    lines.push('');
    lines.push('**検証根拠**:');
    for (const e of evList2) lines.push(`- ${mdCell(e)}`);
  }

  const histList = history || [];
  if (histList.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    lines.push('');
    lines.push('| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |');
    lines.push('|---|---|---|---|---|');
    for (const round of histList) {
      const rEmoji = DECISION_EMOJI[round.decision] ?? '';
      const rLabel = DECISION_LABEL[round.decision] ?? round.decision;
      const bCount = (round.blocking ?? []).length;
      const mCount = (round.minor ?? []).length;
      const rawSummary = mdCell(round.summary);
      const rSummary = rawSummary.length > 120 ? rawSummary.slice(0, 120) + '…' : rawSummary;
      lines.push(`| ${round.iteration} | ${rEmoji} ${rLabel} | ${bCount} | ${mCount} | ${rSummary} |`);
    }
  }

  const allBlocking = histList.flatMap((r) => (r.blocking ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalBlocking = allBlocking.length;
  if (totalBlocking > 0) {
    lines.push('');
    lines.push(`<details><summary>要修正（blocking）指摘の全詳細（${totalBlocking} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allBlocking, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  const allMinor = histList.flatMap((r) => (r.minor ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalMinor = allMinor.length;
  if (totalMinor > 0) {
    lines.push('');
    lines.push(`<details><summary>軽微な指摘（minor）の全詳細（自動修正対象外・${totalMinor} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allMinor, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}
