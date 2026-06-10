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
 * Markdown テーブルセルの値をエスケープする。
 * パイプ文字を \| に、改行を <br> に変換する。
 * @param {*} v
 * @returns {string}
 */
export function mdCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * dev-flow 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.mergeTier - 'HOLD'|'REVIEW'|'AUTO'
 * @param {string[]} opts.mergeTierReasons - 理由文字列の配列
 * @param {string} opts.gatePolicy - gate policy 文字列（例 'llm-major-advisory'）
 * @param {Array<{id,text,severity,checked,dimension,evidence}>} opts.blockingItems - blocking items
 * @param {Array<{id,text,severity,checked,dimension,evidence,escalate,escalate_reason}>} opts.advisoryItems - advisory items
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

  const TIER_EMOJI = { 'HOLD': '🔶', 'REVIEW': '🔷', 'AUTO': '✅' };

  // 1. 見出し
  lines.push(`## dev-flow 終端サマリー — PR #${pr}`);
  lines.push('');

  // 2. at-a-glance テーブル
  const tierCell = `${TIER_EMOJI[mergeTier] ?? ''} **${mergeTier}**`;
  const shapeCell = shape != null ? shape : '不明';
  let testCell;
  if (testGreen == null) {
    testCell = '不明';
  } else if (testGreen === true) {
    testCell = '✅ green';
  } else {
    testCell = '❌ red';
  }
  let evalCell;
  if (evalVerdict == null) {
    evalCell = '不明';
  } else if (evalVerdict === 'pass') {
    evalCell = '✅ pass';
  } else {
    evalCell = `❌ ${evalVerdict}`;
  }
  const ledgerCell = ledgerConverged ? '✅ 収束' : '⚠️ 未収束';
  const acArr = acResults && acResults.length > 0 ? acResults : null;
  let acCell;
  if (!acArr) {
    acCell = '—';
  } else {
    const s = acArr.filter(a => a.satisfied === true).length;
    const t = acArr.length;
    acCell = s === t ? `✅ ${s}/${t}` : `❌ ${s}/${t}`;
  }
  const dangerArr = dangerHits && dangerHits.length > 0 ? dangerHits : null;
  const dangerCell = dangerArr ? `⚠️ ${dangerArr.length} クラス` : '✅ clean';

  lines.push('| Merge tier | shape | test | eval | Ledger | AC | danger |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| ${tierCell} | ${shapeCell} | ${testCell} | ${evalCell} | ${ledgerCell} | ${acCell} | ${dangerCell} |`);
  lines.push('');

  // 3. gate_policy 行
  lines.push(`gate_policy: \`${gatePolicy}\``);

  // 4. dangerHits 検出クラス行（1件以上のとき）
  if (dangerArr) {
    lines.push(`検出クラス: ${dangerArr.join(', ')}`);
  }

  // 5. Merge tier 理由（常時可視）
  lines.push('');
  lines.push('**Merge tier 理由**:');
  if (!mergeTierReasons || mergeTierReasons.length === 0) {
    lines.push('- 理由記載なし');
  } else {
    for (const reason of mergeTierReasons) {
      lines.push(`- ${reason}`);
    }
  }

  // 6. 要対応セクション（常時可視）
  // 未解消事項を収集
  const blockArr = blockingItems || [];
  const advArr = advisoryItems || [];
  const uncheckedBlocking = blockArr.filter(it => it.checked !== true);
  const uncheckedAdvisory = advArr.filter(it => it.checked !== true);
  const escalatedChecked = advArr.filter(it => it.escalate === true && it.checked === true);
  const unsatisfiedAC = acArr ? acArr.filter(a => a.satisfied !== true) : [];
  const uncleared = securityClearance && securityClearance.length > 0
    ? securityClearance.filter(sc => sc.cleared !== true)
    : [];
  const concerns = planConcerns || [];

  const hasActionItems = uncheckedBlocking.length > 0
    || uncheckedAdvisory.length > 0
    || escalatedChecked.length > 0
    || unsatisfiedAC.length > 0
    || uncleared.length > 0
    || concerns.length > 0;

  lines.push('');
  if (!hasActionItems) {
    lines.push('### ✅ 要対応事項なし');
  } else {
    lines.push('### ⚠️ 要対応');

    // ledger 未解消テーブル（(i)(ii)(iii)）
    const ledgerActionItems = [
      ...uncheckedBlocking.map(it => ({ ...it, _lane: 'blocking' })),
      ...uncheckedAdvisory.map(it => ({
        ...it,
        _lane: it.escalate ? 'advisory (ESCALATE)' : 'advisory',
      })),
      ...escalatedChecked.map(it => ({ ...it, _lane: 'advisory (ESCALATE)', _forceVisible: true })),
    ];

    if (ledgerActionItems.length > 0) {
      lines.push('');
      lines.push('| 状態 | id | lane | dimension | 内容 |');
      lines.push('|---|---|---|---|---|');
      for (const item of ledgerActionItems) {
        const status = (item.checked === true && item.escalate) ? '⚠️ 要判断' : '❌ 未解消';
        const dimension = item.dimension != null ? item.dimension : '—';
        let content = mdCell(item.text);
        if (item.evidence) {
          content += ': ' + mdCell(item.evidence);
        }
        if (item.escalate_reason) {
          content += `（reason: ${mdCell(item.escalate_reason)}）`;
        }
        lines.push(`| ${status} | ${item.id} | ${item._lane} | ${dimension} | ${content} |`);
      }
    }

    // 未達 AC テーブル（(iv)）
    if (unsatisfiedAC.length > 0) {
      lines.push('');
      lines.push('| 状態 | AC | 検証 | evidence |');
      lines.push('|---|---|---|---|');
      for (const ac of unsatisfiedAC) {
        const verifiedBy = ac.verified_by != null ? ac.verified_by : 'inspection';
        const evidenceCell = ac.evidence ? mdCell(ac.evidence) : '—';
        lines.push(`| ❌ 未達 | AC#${ac.ac_index + 1} | ${verifiedBy} | ${evidenceCell} |`);
      }
    }

    // 未確認 clearance テーブル（(v)）
    if (uncleared.length > 0) {
      lines.push('');
      lines.push('| 状態 | danger class | evidence |');
      lines.push('|---|---|---|');
      for (const sc of uncleared) {
        const evidenceCell = sc.evidence ? mdCell(sc.evidence) : '—';
        lines.push(`| ❌ 未確認 | ${sc.danger_class} | ${evidenceCell} |`);
      }
    }

    // Plan concerns（(vi)）
    if (concerns.length > 0) {
      lines.push('');
      lines.push('**Plan 未解消 concerns**:');
      for (const concern of concerns) {
        lines.push(`- ${concern}`);
      }
    }
  }

  // 8. 空状態の常時可視行
  if (blockArr.length === 0 && advArr.length === 0) {
    lines.push('Goal Ledger: item なし');
  }
  if (!acResults || acResults.length === 0) {
    lines.push('Acceptance Criteria: AC 判定なし（evaluator 未実行 or AC 欠落）');
  }
  if (!securityClearance || securityClearance.length === 0) {
    lines.push('Security clearance: danger-grep clean（clearance 不要）');
  }

  // 7. 折りたたみブロック群（AC-3）

  // 解消済み ledger
  const resolvedItems = [
    ...blockArr.filter(it => it.checked === true).map(it => ({ ...it, _lane: 'blocking' })),
    ...advArr.filter(it => it.checked === true && it.escalate !== true).map(it => ({ ...it, _lane: 'advisory' })),
  ];
  if (resolvedItems.length > 0) {
    const n = resolvedItems.length;
    lines.push('');
    lines.push(`<details><summary>✅ Goal Ledger 解消済み ${n} 件</summary>`);
    lines.push('');
    lines.push('| id | lane | dimension | 内容 | evidence |');
    lines.push('|---|---|---|---|---|');
    for (const item of resolvedItems) {
      const dimension = item.dimension != null ? item.dimension : '—';
      const content = mdCell(item.text);
      const evidence = item.evidence ? mdCell(item.evidence) : '—';
      lines.push(`| ${item.id} | ${item._lane} | ${dimension} | ${content} | ${evidence} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  // satisfied AC
  if (acArr) {
    const satisfiedAC = acArr.filter(a => a.satisfied === true);
    const s = satisfiedAC.length;
    const t = acArr.length;
    if (s > 0) {
      lines.push('');
      lines.push(`<details><summary>✅ Acceptance Criteria ${s}/${t} satisfied</summary>`);
      lines.push('');
      lines.push('| AC | 検証 | evidence |');
      lines.push('|---|---|---|');
      for (const ac of satisfiedAC) {
        const verifiedBy = ac.verified_by != null ? ac.verified_by : 'inspection';
        const evidenceCell = ac.evidence ? mdCell(ac.evidence) : '—';
        lines.push(`| AC#${ac.ac_index + 1} | ${verifiedBy} | ${evidenceCell} |`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }

  // cleared security clearance
  if (securityClearance && securityClearance.length > 0) {
    const cleared = securityClearance.filter(sc => sc.cleared === true);
    const c = cleared.length;
    const ct = securityClearance.length;
    if (c > 0) {
      lines.push('');
      lines.push(`<details><summary>✅ Security clearance ${c}/${ct} cleared</summary>`);
      lines.push('');
      lines.push('| danger class | evidence |');
      lines.push('|---|---|');
      for (const sc of cleared) {
        const evidenceCell = sc.evidence ? mdCell(sc.evidence) : '—';
        lines.push(`| ${sc.danger_class} | ${evidenceCell} |`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }

  // 9. 末尾
  lines.push('');
  lines.push('---');
  lines.push('*このコメントは dev-flow により自動生成されました。*');
  lines.push(`<!-- dev-flow:${mergeTier} -->`);

  return lines.join('\n');
}
