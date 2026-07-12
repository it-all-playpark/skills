// buildDevflowSummaryBody: dev-flow の終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 等の非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * dev-flow 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.mergeTier - 'HOLD'|'REVIEW'|'AUTO'
 * @param {string[]} opts.mergeTierReasons - 理由文字列の配列
 * @param {string} opts.gatePolicy - gate policy 文字列（例 'llm-major-advisory'）
 * @param {Array<{id,text,severity,checked,dimension,evidence,source,floor,danger_class,fail_closed}>} opts.blockingItems - blocking items。
 *   SEC seed item（source:'seed' && dimension:'security'）は danger-grep 由来の決定論 floor item で、
 *   floor:true が付いた item から Security clearance セクションを導出する（checked/evidence/danger_class を使用）。
 *   fail_closed:true は danger-grep-final 実行不能を示し、専用の fail-closed 空状態行を出す
 * @param {Array<{id,text,severity,checked,dimension,evidence,escalate,escalate_reason,env_key,env_count}>} opts.advisoryItems - advisory items（dimension:'environment' の item は env_key/env_count を任意付帯し「環境ノート」に折りたたみ表示される。issue #296。checked な environment item は環境ノートで ✅ CI確認済 と表示される（issue #297））
 * @param {boolean} opts.ledgerConverged - ledger 収束フラグ
 * @param {Array<{ac_index,satisfied,evidence,verified_by}>|null|undefined} opts.acResults - AC 判定結果
 * @param {string[]} opts.planConcerns - Plan phase 未解消 concerns
 * @param {string[]} opts.dangerHits - danger-grep で検出したクラス名
 * @param {string|null|undefined} opts.shape - 実効 shape（'micro'|'standard'|'complex'）
 * @param {boolean|null|undefined} opts.testGreen - test green フラグ
 * @param {string|null|undefined} opts.evalVerdict - evaluator verdict（'pass'|'fail' 等）
 * @param {string|null|undefined} opts.evalStaleness - 'none'|'hash_mismatch'|'iterate_incomplete'|'iterate_fixed'（issue #288）
 * @param {number|null|undefined} opts.iterateFixesApplied - pr-iterate の適用 fix 件数（iterate_fixed 表示用）
 * @param {string|null|undefined} opts.uiVerify - ui-verify 結果（'skipped'|'passed'|'findings'|'failed_open'|'setup_failed'。issue #285）
 * @param {string|null|undefined} opts.uiVerifyMode - ui-verify モード（'scenario'|'smoke'。issue #285）
 * @param {string|null|undefined} opts.finalReconcile - Final reconcile 結果（'skipped'|'reverified'|'unavailable'。issue #320）
 * @param {boolean|null|undefined} opts.finalTestGreen - Final reconcile 時の test green フラグ（issue #320）
 * @param {string|null|undefined} opts.finalUiVerify - Final reconcile 時の ui-verify 結果（'passed'|'findings'|'failed_open'|'setup_failed'。issue #320）
 * @param {string|null|undefined} opts.finalAcReconcile - Final AC reconcile 結果（'skipped'|'reverified'|'unavailable'。issue #331）
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
  planConcerns,
  dangerHits,
  shape,
  testGreen,
  evalVerdict,
  evalStaleness,
  iterateFixesApplied,
  uiVerify,
  uiVerifyMode,
  finalReconcile,
  finalTestGreen,
  finalUiVerify,
  finalAcReconcile,
}) {
  const EVAL_STALENESS_VALUES = ['none', 'hash_mismatch', 'iterate_incomplete', 'iterate_fixed'];
  if (evalStaleness != null && !EVAL_STALENESS_VALUES.includes(evalStaleness)) {
    throw new Error('buildDevflowSummaryBody: invalid evalStaleness: ' + evalStaleness);
  }

  const FINAL_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable'];
  if (finalReconcile != null && !FINAL_RECONCILE_VALUES.includes(finalReconcile)) {
    throw new Error('buildDevflowSummaryBody: invalid finalReconcile: ' + finalReconcile);
  }

  const FINAL_AC_RECONCILE_VALUES_LOCAL = ['skipped', 'reverified', 'unavailable'];
  if (finalAcReconcile != null && !FINAL_AC_RECONCILE_VALUES_LOCAL.includes(finalAcReconcile)) {
    throw new Error('buildDevflowSummaryBody: invalid finalAcReconcile: ' + finalAcReconcile);
  }

  // Security clearance は最終 ledger の SEC seed item（source:'seed' && dimension:'security' && floor:true）
  // から導出する（evalResult.security_clearance は使わない — PR #16 型の表示矛盾を防ぐため）。
  // SEC seed item は check.kind:'deterministic' のため全 gate_policy で blocking lane（軸A invariant）
  // であり、blockingItems からの導出は gate_policy に依存せず成立する。
  const secLedgerItems = (blockingItems || []).filter(
    (it) => it.source === 'seed' && it.dimension === 'security' && it.floor === true
  );
  const securityClearance = secLedgerItems.map((it) => ({
    danger_class: it.danger_class,
    cleared: it.checked === true,
    evidence: it.evidence,
  }));
  // fail_closed:true の SEC seed item がある場合、danger-grep-final が実行不能だったことを示す。
  // この場合は「clean（clearance 不要）」と混同せず、専用の fail-closed 空状態行を出す。
  const secFailClosed = (blockingItems || []).some(
    (it) => it.source === 'seed' && it.dimension === 'security' && it.fail_closed === true
  );

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

  // 2b. eval_staleness 警告（at-a-glance テーブル直後・gate_policy 行前。issue #288）
  if (evalStaleness === 'hash_mismatch') {
    lines.push('> \u26a0\ufe0f **Evaluate は古い tree に対して実行された**（Evaluate 時点と PR phase 直前の diff hash が不一致。eval/AC/security clearance の判定は現在の PR 内容を反映していない可能性がある）');
    lines.push('');
  } else if (evalStaleness === 'iterate_incomplete') {
    lines.push('> \u26a0\ufe0f **pr-iterate が LGTM 以外で終端した**（fix 適用後の tree に対する再評価・LGTM が得られていない。eval/AC/security clearance の判定は現在の PR 内容を反映していない可能性がある）');
    lines.push('');
  } else if (evalStaleness === 'iterate_fixed') {
    const fixCount = (typeof iterateFixesApplied === 'number' && iterateFixesApplied >= 0) ? String(iterateFixesApplied) : '不明';
    lines.push('> \u2139\ufe0f **pr-iterate が ' + fixCount + ' 件の fix を適用して LGTM 終端**（fix 内容は pr-reviewer の再レビューで担保済み。下記の eval/AC テーブル・security clearance は fix 前 tree 基準）');
    lines.push('');
  }

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

  // 5b. UI 検証（ui-verify）結果行（issue #285。skipped/null/undefined では出力しない）
  if (uiVerify != null && uiVerify !== 'skipped') {
    const modeSuffix = uiVerifyMode ? ` (mode: ${uiVerifyMode})` : '';
    lines.push(`- UI 検証 (ui-verify): ${uiVerify}${modeSuffix}`);
  }

  // 5c. Final reconcile 結果行（issue #320。null/undefined/'skipped' では出力しない）
  if (finalReconcile != null && finalReconcile !== 'skipped') {
    const t = finalTestGreen === true ? '✅ green' : finalTestGreen === false ? '❌ red' : '不明';
    lines.push(`- Final reconcile (pr-iterate fix 後の最終 tree 再検証): ${finalReconcile} — final test: ${t}` + (finalUiVerify != null ? `, final ui-verify: ${finalUiVerify}` : '') + (finalAcReconcile != null ? `, final AC: ${finalAcReconcile}` : ''));
    if (finalAcReconcile === 'reverified') {
      lines.push('- ✅ AC は最終 PR tree で再検証済み（Final AC reconcile — AC テーブルは final snapshot）');
    } else if (finalAcReconcile !== 'reverified' && acArr) {
      lines.push('- ⚠️ AC 判定は stale（fix 適用後の最終 tree に対する AC 再検証が未実施/判定不能 — AC テーブルは Evaluate 時点（fix 前 tree）基準であり final ではない）');
    }
  }

  // 6. 要対応セクション（常時可視）
  // 未解消事項を収集
  const blockArr = blockingItems || [];
  const advArr = advisoryItems || [];
  const envItems = advArr.filter(it => it.dimension === 'environment');
  const uncheckedBlocking = blockArr.filter(it => it.checked !== true);
  const uncheckedAdvisory = advArr.filter(it => it.checked !== true && it.dimension !== 'environment');
  const escalatedChecked = advArr.filter(it => it.escalate === true && it.checked === true && it.dimension !== 'environment');
  const unsatisfiedAC = acArr ? acArr.filter(a => a.satisfied !== true) : [];
  const uncleared = securityClearance.filter(sc => sc.cleared !== true);
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
      // id 列は出さない（ledger 内部識別子はレビュアーにはノイズ。機構側は ledger データを直接参照する）
      lines.push('| 状態 | lane | dimension | 内容 |');
      lines.push('|---|---|---|---|');
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
        lines.push(`| ${status} | ${item._lane} | ${dimension} | ${content} |`);
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
  // 直前コンテンツ（テーブル行 / bullet）との間に必ず空行を挿入する。
  // GFM はテーブル終端行を空行で判定し、bullet も lazy continuation で吸収するため
  // 空行なしで push するとテーブル壊れ・bullet 併合が起きる（AC-2 実効性を損なう）。
  if (lines[lines.length - 1] !== '') lines.push('');
  if (blockArr.length === 0 && advArr.length === 0) {
    lines.push('Goal Ledger: item なし');
  }
  if (!acResults || acResults.length === 0) {
    lines.push('Acceptance Criteria: AC 判定なし（evaluator 未実行 or AC 欠落）');
  }
  if (securityClearance.length === 0) {
    if (secFailClosed) {
      lines.push('Security clearance: danger-grep 実行不能（fail-closed — security 未検証）');
    } else {
      lines.push('Security clearance: danger-grep clean（clearance 不要）');
    }
  }

  // 7. 折りたたみブロック群（AC-3）

  // 解消済み ledger
  const resolvedItems = [
    ...blockArr.filter(it => it.checked === true).map(it => ({ ...it, _lane: 'blocking' })),
    ...advArr.filter(it => it.checked === true && it.escalate !== true && it.dimension !== 'environment').map(it => ({ ...it, _lane: 'advisory' })),
  ];
  if (resolvedItems.length > 0) {
    const n = resolvedItems.length;
    lines.push('');
    lines.push(`<details><summary>✅ Goal Ledger 解消済み ${n} 件</summary>`);
    lines.push('');
    lines.push('| lane | dimension | 内容 | evidence |');
    lines.push('|---|---|---|---|');
    for (const item of resolvedItems) {
      const dimension = item.dimension != null ? item.dimension : '—';
      const content = mdCell(item.text);
      const evidence = item.evidence ? mdCell(item.evidence) : '—';
      lines.push(`| ${item._lane} | ${dimension} | ${content} | ${evidence} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  // 環境ノート（issue #296: sandbox 環境事象 — 折りたたみ表示、人間の対応は通常不要）
  if (envItems.length > 0) {
    const n = envItems.length;
    lines.push('');
    lines.push(`<details><summary>🏗 環境ノート ${n} 件（sandbox 環境事象 — 人間の対応は通常不要）</summary>`);
    lines.push('');
    lines.push('| 状態 | pattern | 件数 | 内容 | evidence |');
    lines.push('|---|---|---|---|---|');
    for (const item of envItems) {
      const status = item.checked === true ? '✅ CI確認済' : '—';
      const pattern = item.env_key != null ? item.env_key : '—';
      const envCount = typeof item.env_count === 'number' ? String(item.env_count) : '1';
      const content = mdCell(item.text);
      const evidence = item.evidence ? mdCell(item.evidence) : '—';
      lines.push(`| ${status} | ${pattern} | ${envCount} | ${content} | ${evidence} |`);
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
  if (securityClearance.length > 0) {
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
