// buildDevflowSummaryBody: dev-flow の終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 等の非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: .claude/workflows/dev-flow.js は Claude Code の
// dynamic workflow ローダーが独自の VM コンテキストで評価するため、ESM の
// import 文（`import { buildDevflowSummaryBody } from '../../_lib/devflow-summary-format.mjs'` 等）
// は使用できない。そのため dev-flow.js にこの関数本体を inline コピーしており、
// _lib/devflow-summary-format.sync.test.mjs がその byte 一致を CI で保証する。
// この関数を修正する際は、必ず dev-flow.js の inline コピーも同期すること。

/**
 * dev-flow 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.mergeTier - 'HOLD'|'REVIEW'|'AUTO'
 * @param {string[]} opts.mergeTierReasons - 理由文字列の配列
 * @param {string} opts.gatePolicy - gate policy 文字列（例 'llm-major-advisory'）
 * @param {Array<{id,text,severity,checked,dimension,evidence}>} opts.blockingItems - blocking items
 * @param {Array<{id,text,severity,checked,dimension,evidence,escalate}>} opts.advisoryItems - advisory items
 * @param {boolean} opts.ledgerConverged - ledger 収束フラグ
 * @param {Array<{ac_index,satisfied,evidence,verified_by}>|null|undefined} opts.acResults - AC 判定結果
 * @param {Array<{danger_class,cleared,evidence}>|null|undefined} opts.securityClearance - security clearance
 * @param {string[]} opts.planConcerns - Plan phase 未解消 concerns
 * @param {string[]} opts.dangerHits - danger-grep で検出したクラス名
 * @param {string|null|undefined} opts.shape - 実効 shape（'micro'|'standard'|'complex'）
 * @param {boolean|null|undefined} opts.testGreen - test green フラグ
 * @param {string|null|undefined} opts.evalVerdict - evaluator verdict（'pass'|'fail' 等）
 * @returns {string}
 */
export function buildDevflowSummaryBody({
  pr,
  mergeTier,
  mergeTierReasons,
  gatePolicy,
  blockingItems,
  advisoryItems,
  ledgerConverged,
  acResults,
  securityClearance,
  planConcerns,
  dangerHits,
  shape,
  testGreen,
  evalVerdict,
}) {
  const lines = [];

  // 1. 見出し
  lines.push(`## dev-flow 終端サマリー — PR #${pr}`);
  lines.push('');

  // 2. Merge tier セクション
  lines.push(`### Merge tier: ${mergeTier}`);
  if (!mergeTierReasons || mergeTierReasons.length === 0) {
    lines.push('- 理由記載なし');
  } else {
    for (const reason of mergeTierReasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push('');

  // 3. 実行結果サマリー（shape / test_green / eval_verdict）
  lines.push('### 実行結果');
  lines.push(`- shape: ${shape != null ? shape : '不明'}`);
  lines.push(`- test_green: ${testGreen != null ? String(testGreen) : '不明'}`);
  lines.push(`- eval_verdict: ${evalVerdict != null ? evalVerdict : '不明'}`);
  lines.push('');

  // 4. Goal Ledger セクション
  lines.push('### Goal Ledger');
  lines.push(`- gate_policy: ${gatePolicy}`);
  lines.push(`- 収束: ${ledgerConverged ? '済' : '未収束'}`);

  // blocking items
  if (!blockingItems || blockingItems.length === 0) {
    lines.push('- blocking item なし');
  } else {
    for (const item of blockingItems) {
      const status = item.checked ? 'checked' : '未解消';
      const dimension = item.dimension ? ` [${item.dimension}]` : '';
      const evidence = item.evidence ? ': ' + item.evidence : '';
      lines.push(`- [${status}] ${item.id}${dimension} ${item.text}${evidence}`);
    }
  }

  // advisory items
  if (!advisoryItems || advisoryItems.length === 0) {
    lines.push('- advisory item なし');
  } else {
    for (const item of advisoryItems) {
      const status = item.checked ? 'checked' : '未解消';
      const escalateSuffix = item.escalate ? ' (ESCALATE)' : '';
      const dimension = item.dimension ? ` [${item.dimension}]` : '';
      const evidence = item.evidence ? ': ' + item.evidence : '';
      lines.push(`- [${status}] ${item.id}${dimension} ${item.text}${evidence}${escalateSuffix}`);
    }
  }
  lines.push('');

  // 5. AC evidence セクション
  lines.push('### Acceptance Criteria');
  if (!acResults || acResults.length === 0) {
    lines.push('AC 判定なし（evaluator 未実行 or AC 欠落）');
  } else {
    for (const ac of acResults) {
      const satisfiedLabel = ac.satisfied ? 'satisfied' : '未達';
      const verifiedBy = ac.verified_by != null ? ac.verified_by : 'inspection';
      const evidenceSuffix = ac.evidence ? ': ' + ac.evidence : '';
      lines.push(`- AC#${ac.ac_index + 1}: ${satisfiedLabel}（${verifiedBy}）${evidenceSuffix}`);
    }
  }
  lines.push('');

  // 6. Security clearance セクション
  lines.push('### Security clearance');
  if (!securityClearance || securityClearance.length === 0) {
    lines.push('- danger-grep clean（clearance 不要）');
  } else {
    for (const sc of securityClearance) {
      const clearedLabel = sc.cleared ? 'cleared' : '未確認';
      const evidenceSuffix = sc.evidence ? ': ' + sc.evidence : '';
      lines.push(`- ${sc.danger_class}: ${clearedLabel}${evidenceSuffix}`);
    }
  }
  if (dangerHits && dangerHits.length > 0) {
    lines.push(`- 検出クラス: ${dangerHits.join(', ')}`);
  }
  lines.push('');

  // 7. Plan concerns セクション（空なら省略）
  if (planConcerns && planConcerns.length > 0) {
    lines.push('### Plan 未解消 concerns');
    for (const concern of planConcerns) {
      lines.push(`- ${concern}`);
    }
    lines.push('');
  }

  // 8. 末尾
  lines.push('---');
  lines.push('*このコメントは dev-flow により自動生成されました。*');
  lines.push(`<!-- dev-flow:${mergeTier} -->`);

  return lines.join('\n');
}
