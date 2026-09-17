// buildDevflowSummaryBody: dev-flow の終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 等の非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// マージ後確認の定型文（danger class → 文言）の閉じたテーブル（issue #658）。danger-grep の
// 8 クラス全件を網羅する。未知 class は buildDevflowSummaryBody 側で汎用文にフォールバックする
// （fail-safe。throw しない）。
const POST_MERGE_CHECK = {
  'config': 'CI/CD・環境設定の変更を含む — PR CI で通らない経路（push トリガの deploy workflow 等）があれば対象 workflow の初回実行を確認する',
  'data-migration': 'migration を含む — マージ後に migration が実行される経路（migrate workflow / deploy hook）の初回実行結果を確認し、ロールバック手順を手元に置く',
  'dependency': '依存関係の変更を含む — deploy 環境（CI runner / Dockerfile / deploy workflow）で lockfile・パッケージマネージャ版が解決できるか、マージ後の初回 build / deploy を確認する',
  'auth': '認証・認可経路の変更を含む — マージ後に本番相当環境でログイン / 権限チェックの smoke を行う',
  'crypto': '暗号・秘密情報の扱いの変更を含む — 鍵 / トークンのローテーション要否と、ログへの秘密情報出力がないことを確認する',
  'public-api': '公開 API の変更を含む — 利用側（他 repo / クライアント）への告知と互換性を確認する',
  'exec-sink': '外部コマンド実行経路の変更を含む — 入力の sanitization を再確認し、マージ後の実行ログに異常がないか監視する',
  'test-weakening': 'テスト弱体化の疑いを含む — マージ後の CI で当該テストが実行されていること（skip / only が残っていないこと）を確認する',
};

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
 *   fail_closed:true は danger-grep-final 実行不能を示し、専用の fail-closed 空状態行を出す。
 *   blocking lane では item.final_resolution / item.final_evidence を無視する（軸A invariant。issue #658）
 * @param {Array<{id,text,severity,checked,dimension,evidence,escalate,escalate_reason,escalate_description,env_key,env_count,triaged,triaged_evidence,final_resolution,final_evidence}>} opts.advisoryItems - advisory items（dimension:'environment' の item は「環境ノート」として件数のみ常時可視で表示される。issue #296。checked/unchecked を問わず全文（env_key/env_count/evidence 含む）は journal telemetry `resolved_evidence` 側に記録される（issue #297, #603））。
 *   advisory lane かつ `triaged:true` かつ `triaged_evidence` 非空（escalate でない）の item は要対応表・要対応判定から除外し、
 *   要対応セクション直後の `<details>`（🔹 トリアージ済み N 件）に 観点/内容/triaged_evidence を全文で出す（表示のみ。checked/ゲート不変。blocking lane では無視。issue #614, #626）。
 *   `escalate_description`: escalate item の詳細説明（要対応テーブルの内容列に要約として連結。issue #658）。
 *   `final_resolution`: 'resolved'|'ci_delegated'|'unresolved'|undefined — Final AC reconcile が
 *   fix 後の最終 tree で item を再評価した結果（表示専用。checked/ゲート/escalateCount には影響しない。issue #658）。
 *   `final_evidence`: string|null|undefined — final_resolution の根拠
 * @param {boolean} opts.ledgerConverged - ledger 収束フラグ
 * @param {Array<{ac_index,satisfied,evidence,verified_by}>|null|undefined} opts.acResults - AC 判定結果
 * @param {string[]} opts.planConcerns - Plan phase 未解消 concerns。blockingItems/advisoryItems 内の
 *   dimension:'concern' かつ checked:true な item と text 完全一致するものは解消済みとして表示から
 *   除外する（issue #611）
 * @param {string[]} opts.dangerHits - danger-grep で検出したクラス名
 * @param {string[]} [opts.testsurfHits] - danger-grep（test-weakening クラス）で検出した TESTSURF pattern 名の配列（issue #362）
 * @param {string|null|undefined} opts.shape - 実効 shape（'micro'|'standard'|'complex'）
 * @param {boolean|null|undefined} opts.testGreen - test green フラグ（at-a-glance 表では finalReconcile が 'ci_verified'/'reverified' のとき最終状態を優先。issue #625）
 * @param {string|null|undefined} opts.evalVerdict - evaluator verdict（'pass'|'fail' 等）（at-a-glance 表では iterate_fixed+lgtm+finalAcReconcile=reverified の fail を '✅ pass (fix 後 LGTM)' と表示。issue #625）
 * @param {string|null|undefined} opts.evalStaleness - 'none'|'hash_mismatch'|'hash_reconverged'|'iterate_incomplete'|'iterate_fixed'（issue #288, #631）
 * @param {string|null|undefined} [opts.evalDiffHash] - Evaluate 時点の tree diff hash（issue #631）
 * @param {string|null|undefined} [opts.prDiffHash] - PR phase 直前の tree diff hash（issue #631）
 * @param {Array<{path:string,insertions:number,deletions:number}>|null|undefined} [opts.staleDiffFiles] - hash_mismatch/hash_reconverged 時の eval→PR 直前の差分ファイル一覧。null は取得失敗（issue #631）
 * @param {string|null|undefined} [opts.prHeadTreeOid] - PR head commit の tree OID（issue #631）
 * @param {number|null|undefined} opts.iterateFixesApplied - pr-iterate の適用 fix 件数（iterate_fixed 表示用）
 * @param {string|null|undefined} opts.uiVerify - ui-verify 結果（'skipped'|'passed'|'findings'|'failed_open'|'setup_failed'。issue #285）
 * @param {string|null|undefined} opts.uiVerifyMode - ui-verify モード（'scenario'|'smoke'。issue #285）
 * @param {string|null|undefined} opts.finalReconcile - Final reconcile 結果（'skipped'|'reverified'|'unavailable'|'ci_verified'。issue #320, #599）
 * @param {boolean|null|undefined} opts.finalTestGreen - Final reconcile 時の test green フラグ（issue #320）
 * @param {string|null|undefined} opts.finalUiVerify - Final reconcile 時の ui-verify 結果（'passed'|'findings'|'failed_open'|'setup_failed'。issue #320）
 * @param {string|null|undefined} opts.finalAcReconcile - Final AC reconcile 結果（'skipped'|'reverified'|'unavailable'。issue #331）
 * @param {{decision:string|null, ci:string, summary:string|null}|null|undefined} [opts.liteReview] - dev-flow lite 経路の pr-review-lite 結果。非 null の場合のみ「lite レビュー」セクションを描画する（issue #392 AC-6）
 * @param {string|null|undefined} [opts.iterateStatus] - pr-iterate 終端 status（'lgtm'|'stuck'|'fix_failed'|'max_reached'|'ci_error'|'ci_pending'|'review_contract_error'。非 'lgtm' のときのみ未解消指摘セクションを描画する。issue #602）
 * @param {Array<{iteration:number,decision:string,summary:string,blocking:Array<{severity,topic,file,line,description,suggestion}>,minor:Array}>|null|undefined} [opts.iterateHistory] - pr-iterate の round 履歴（issue #602）
 * @param {number|null|undefined} [opts.iterateIterations] - pr-iterate 返り値 iterations。history 末尾 round の iteration と一致するときのみその round を終端 round とみなす（ci_error/ci_pending/review_contract_error は終端 round を history に push しないため）。null なら末尾 round を採用（issue #602）
 * @param {Array<{code:string, reason:string, kind:'deterministic_recheck'|'human_judgment'}>|null|undefined} [opts.holdReasons] - HOLD 判定に寄与した理由（HOLD 時のみ非空。merge-tier.mjs の
 *   閉じた code enum（HOLD_REASON_CODES）を持つ）。summary は code から「現状/対応」列を fail-safe に
 *   写像する（out-of-enum/欠落は '—' / '人が確認する'。throw しない。表示専用。issue #658）
 * @param {'deterministic_recheck'|'human_judgment'|null|undefined} [opts.holdKind] - HOLD 理由の代表 kind（merge-tier.mjs の aggregateHoldKind の返り値。issue #658）
 * @param {string[]|null|undefined} [opts.disclosures] - 可視化のみで HOLD 判定に寄与しない理由行（breaking keyword hit 等）。
 *   非 HOLD tier では Merge tier 理由の箇条書きから除外し「参考」セクションへ回す（HOLD tier は従来どおり
 *   mergeTierReasons を無加工で列挙する。issue #658）
 * @param {string[]|null|undefined} [opts.changedFiles] - 変更ファイルパス一覧。`.github/workflows/` 配下の変更が
 *   含まれる場合、あなたがやること に「マージ後: 対象 workflow の初回実行を確認する」を追加する
 *   （config danger class は .env / config/*.yml / secret 代入のみを判定し .github/workflows/*.yml に
 *   一致しないため、workflow 変更は別途 changedFiles から直接検出する。issue #662）
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
  testsurfHits,
  shape,
  testGreen,
  evalVerdict,
  evalStaleness,
  evalDiffHash,
  prDiffHash,
  staleDiffFiles,
  prHeadTreeOid,
  iterateFixesApplied,
  uiVerify,
  uiVerifyMode,
  finalReconcile,
  finalTestGreen,
  finalUiVerify,
  finalAcReconcile,
  liteReview,
  iterateStatus,
  iterateHistory,
  iterateIterations,
  holdReasons,
  holdKind,
  disclosures,
  changedFiles,
}) {
  const EVAL_STALENESS_VALUES = ['none', 'hash_mismatch', 'hash_reconverged', 'iterate_incomplete', 'iterate_fixed'];
  if (evalStaleness != null && !EVAL_STALENESS_VALUES.includes(evalStaleness)) {
    throw new Error('buildDevflowSummaryBody: invalid evalStaleness: ' + evalStaleness);
  }

  const FINAL_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable', 'ci_verified'];
  if (finalReconcile != null && !FINAL_RECONCILE_VALUES.includes(finalReconcile)) {
    throw new Error('buildDevflowSummaryBody: invalid finalReconcile: ' + finalReconcile);
  }

  const FINAL_AC_RECONCILE_VALUES_LOCAL = ['skipped', 'reverified', 'unavailable'];
  if (finalAcReconcile != null && !FINAL_AC_RECONCILE_VALUES_LOCAL.includes(finalAcReconcile)) {
    throw new Error('buildDevflowSummaryBody: invalid finalAcReconcile: ' + finalAcReconcile);
  }

  // 非空文字列判定（final_evidence / escalate_description の妥当性チェックに使う。issue #658）。
  const nonEmpty = (s) => typeof s === 'string' && s.length > 0;

  // advisory item の「fix 後 tree での再評価」解消判定。blocking lane では呼ばない（軸A invariant）。
  // 'resolved': fix 後の最終 tree で直接再検証済み。'ci_delegated': ローカル再検証不能だったが
  // finalReconcile==='ci_verified'（PR head sha 一致・CI check 全 success）のときのみ解消扱い
  // （それ以外の finalReconcile では「CI が実際に success した」決定論事実がないため未解消のまま）。
  const isResolved = (it) => {
    if (it.final_resolution === 'resolved' && nonEmpty(it.final_evidence)) return true;
    if (it.final_resolution === 'ci_delegated' && nonEmpty(it.final_evidence) && finalReconcile === 'ci_verified') return true;
    return false;
  };

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

  // TESTSURF clearance は最終 ledger の TESTSURF seed item（source:'seed' && id が 'TESTSURF-' 始まり）
  // から導出する（SEC seed item と同型。issue #362）。id 形式は `TESTSURF-<PATTERN>` 固定。
  const testsurfLedgerItems = (blockingItems || []).filter(
    (it) => it.source === 'seed' && typeof it.id === 'string' && it.id.startsWith('TESTSURF-')
  );
  const testsurfClearance = testsurfLedgerItems.map((it) => ({
    pattern: it.id.slice('TESTSURF-'.length),
    cleared: it.checked === true,
    evidence: it.evidence,
  }));

  // ─── 要対応判定に使う派生集合（結論行・あなたがやること・要対応表で共有する。issue #658） ───
  const blockArr = blockingItems || [];
  const advArr = advisoryItems || [];
  const envItems = advArr.filter(it => it.dimension === 'environment');
  const uncheckedBlocking = blockArr.filter(it => it.checked !== true);

  // triaged: evaluator が「再検証済み・対応不要」と判断した advisory item の表示専用フラグ
  // （checked は false のまま・ゲート不変。issue #614）。evidence 非空文字列のときのみ有効。
  const isTriaged = (it) => it.triaged === true && typeof it.triaged_evidence === 'string' && it.triaged_evidence.length > 0;
  // triaged advisory: 要対応表・hasActionItems から除外し、要対応セクション直後の <details> に全文で残す（issue #626）。
  // escalate:true は要判断として要対応に残す（escalate 優先）。environment は環境ノート経路（除外）。blocking lane では triaged を無視する（#614 仕様 4 項）。
  const isTriagedAdvisory = (it) => it.checked !== true && it.dimension !== 'environment' && it.escalate !== true && isTriaged(it);
  const triagedAdvisory = advArr.filter(isTriagedAdvisory);

  // escalate 行は「全 escalate」（checked / 解消済みを問わず）を要対応表に常時表示する（issue #658）。
  // 解消状態は行の状態/現状/対応列に反映するが、行自体は隠さない — HOLD の ESCALATE は
  // human required-block のままであることを可視化する。
  const escalateAll = advArr.filter(it => it.escalate === true && it.dimension !== 'environment');
  // 非 escalate advisory の要対応表候補は checked（solved 状態）基準のみで選ぶ（従来と同一の選別）。
  const nonEscalateUnchecked = advArr.filter(
    it => it.checked !== true && it.dimension !== 'environment' && it.escalate !== true && !isTriagedAdvisory(it)
  );
  // hasActionItems（見出し判定）には isResolved で解消済みのものを含めない。
  const unresolvedEscalate = escalateAll.filter(it => !isResolved(it));
  const unresolvedAdvisory = nonEscalateUnchecked.filter(it => !isResolved(it));
  // 解消済み advisory（escalate 含む・environment/triaged 除く）の件数のみ表示用（issue #658）。
  const resolvedAdvisory = advArr.filter(it => it.dimension !== 'environment' && !isTriagedAdvisory(it) && isResolved(it));

  const acArr = acResults && acResults.length > 0 ? acResults : null;
  const unsatisfiedAC = acArr ? acArr.filter(a => a.satisfied !== true) : [];
  const uncleared = securityClearance.filter(sc => sc.cleared !== true);

  // Plan 未解消 concerns は Plan phase 収束時のスナップショット（更新されない）だが、CONCERN-*
  // ledger item（dimension:'concern'）は evaluator の concern_resolutions で checked/evidence
  // 更新される。dev-flow.js は planConcerns の文字列を無加工で CONCERN-* の text に seed するため、
  // text 完全一致で「ledger 上 checked 済み」を判定できる（issue #611）。同一 text が checked と
  // unchecked の両方にある場合は unchecked を優先し表示を残す（fail-safe。見落とし防止）。
  // triaged は要対応直後の <details> に全文で残るため箇条書きから除外する（issue #614, #626）。
  const concernLedgerItems = [...blockArr, ...advArr].filter(it => it.dimension === 'concern');
  const settledConcernTexts = new Set(concernLedgerItems.filter(it => it.checked === true || isTriaged(it)).map(it => it.text));
  const unresolvedConcernTexts = new Set(concernLedgerItems.filter(it => it.checked !== true && !isTriaged(it)).map(it => it.text));
  const concerns = (planConcerns || []).filter(c => !(settledConcernTexts.has(c) && !unresolvedConcernTexts.has(c)));

  // hasActionItems: 見出し（⚠️ 要対応 / ✅ 要対応事項なし）の判定にのみ使う。解消済みは数えない。
  const hasActionItems = uncheckedBlocking.length > 0
    || unresolvedEscalate.length > 0
    || unresolvedAdvisory.length > 0
    || unsatisfiedAC.length > 0
    || uncleared.length > 0
    || concerns.length > 0;

  // fixRequired: 結論行・あなたがやること の分岐に使う「修正作業」の要否（escalate/advisory の
  // 要判断・助言は含めない — 人間の判断のみで済む項目は「修正」ではない）。
  // holdReasons に conflict/final_test_red/iterate_non_lgtm の code があれば、他の指標が
  // 空でも修正必須と判定する（PR #662 レビュー: mergeable_conflicting 単独 HOLD で
  // 結論行「修正作業は不要です」と HOLD 理由テーブルの対応列「conflict を解消して push する」が
  // 自己矛盾していた）。
  const FIX_REQUIRED_HOLD_CODES = ['mergeable_conflicting', 'final_test_red', 'iterate_non_lgtm'];
  const fixRequired = uncheckedBlocking.length > 0
    || unsatisfiedAC.length > 0
    || uncleared.length > 0
    || testsurfClearance.some(tc => !tc.cleared)
    || finalTestGreen === false
    || (iterateStatus != null && iterateStatus !== 'lgtm')
    || concerns.length > 0
    || (Array.isArray(holdReasons) && holdReasons.some(hr => FIX_REQUIRED_HOLD_CODES.includes(hr && hr.code)));

  const lines = [];

  const TIER_EMOJI = { 'HOLD': '🔶', 'REVIEW': '🔷', 'AUTO': '✅' };

  // 1. 見出し
  lines.push(`## dev-flow 終端サマリー — PR #${pr}`);
  lines.push('');

  // 2. 結論行（issue #658 AC-1）。要対応テーブルより前・at-a-glance 表より前に置く。
  let tierPhrase;
  if (mergeTier === 'HOLD') tierPhrase = '自動マージ対象外（HOLD）';
  else if (mergeTier === 'REVIEW') tierPhrase = '人間レビュー後にマージ（REVIEW）';
  else tierPhrase = '低リスク・AUTO 推奨（merge は人間）';

  let fixPhrase;
  if (fixRequired) fixPhrase = '修正作業が必要です';
  else if (unresolvedAdvisory.length > 0) fixPhrase = `必須の修正作業はありません（助言 ${unresolvedAdvisory.length} 件は任意）`;
  else fixPhrase = '修正作業は不要です';

  let actionPhrase;
  if (mergeTier === 'HOLD') {
    if (fixRequired) actionPhrase = '「要対応」の ❌ 項目を修正してから再 review してください';
    else if (holdKind === 'deterministic_recheck') actionPhrase = 'CI 完了 / 再取得後に再確認してください';
    else actionPhrase = '人がマージ可否を判断してください';
  } else if (mergeTier === 'REVIEW') {
    actionPhrase = '人が diff を review し LGTM 後にマージしてください';
  } else {
    actionPhrase = '人が diff を一読してマージしてください';
  }

  lines.push(`**結論: ${tierPhrase}。${fixPhrase}。${actionPhrase}**`);
  lines.push('');

  // 3. at-a-glance テーブル
  const tierCell = `${TIER_EMOJI[mergeTier] ?? ''} **${mergeTier}**`;
  const shapeCell = shape != null ? shape : '不明';
  // at-a-glance は最終状態を出す（issue #625）。Final reconcile が最終 tree の test 状態を確定させた
  // 場合はそれを優先し、Validate 時点の testGreen は finalReconcile が 'skipped'/'unavailable'/null
  // （= 最終 tree の再検証が行われていない）のときだけ使う。経過は参考セクションの Final reconcile 行に残る。
  let testCell;
  if (finalReconcile === 'ci_verified') {
    testCell = '✅ green (CI)';
  } else if (finalReconcile === 'reverified') {
    testCell = finalTestGreen === true ? '✅ green' : finalTestGreen === false ? '❌ red' : '不明';
  } else if (testGreen == null) {
    testCell = '不明';
  } else if (testGreen === true) {
    testCell = '✅ green';
  } else {
    testCell = '❌ red';
  }
  // evaluator verdict=fail でも、pr-iterate が fix を適用して LGTM 終端し（iterate_fixed + lgtm）、
  // AC が最終 tree で再検証済み（finalAcReconcile=reverified）なら最終状態は pass。4 条件 AND。
  // 表示のみ — merge tier / HOLD reasons / telemetry の eval_verdict は fix 前 verdict のまま不変。
  let evalCell;
  if (evalVerdict == null) {
    evalCell = '不明';
  } else if (evalVerdict === 'pass') {
    evalCell = '✅ pass';
  } else if (
    evalVerdict === 'fail' && evalStaleness === 'iterate_fixed'
    && iterateStatus === 'lgtm' && finalAcReconcile === 'reverified'
  ) {
    evalCell = '✅ pass (fix 後 LGTM)';
  } else {
    evalCell = `❌ ${evalVerdict}`;
  }
  const ledgerCell = ledgerConverged ? '✅ 収束' : '⚠️ 未収束';
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
  const testsurfArr = testsurfHits && testsurfHits.length > 0 ? testsurfHits : null;
  const hasTestsurf = testsurfArr != null || testsurfClearance.length > 0;

  lines.push('| Merge tier | shape | テスト | 評価 | 台帳 (Ledger) | AC | 危険検出 |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| ${tierCell} | ${shapeCell} | ${testCell} | ${evalCell} | ${ledgerCell} | ${acCell} | ${dangerCell} |`);
  lines.push('');

  // 2b. eval_staleness 警告（at-a-glance テーブル直後・gate_policy 行前。issue #288, #631）
  const short8 = (h) => (typeof h === 'string' && h.length > 0) ? h.slice(0, 8) : '不明';
  const renderDiffFiles = (files) => {
    if (files.length === 0) return '（numstat 空 — mode/permission のみの変更等）';
    const shown = files.slice(0, 10).map((f) => `${f.path} (+${f.insertions}/-${f.deletions})`).join(', ');
    const rest = files.length - 10;
    return rest > 0 ? `${shown} 他 ${rest} 件` : shown;
  };
  if (evalStaleness === 'hash_mismatch') {
    lines.push('> ⚠️ **Evaluate は古い tree に対して実行された**（Evaluate 時点と PR phase 直前の diff hash が不一致: eval ' + short8(evalDiffHash) + ' / PR 直前 ' + short8(prDiffHash) + '。eval/AC/security clearance の判定は現在の PR 内容を反映していない可能性がある）');
    if (Array.isArray(staleDiffFiles)) {
      lines.push('> 差分 ' + staleDiffFiles.length + ' 件: ' + renderDiffFiles(staleDiffFiles));
    } else {
      lines.push('> 差分ファイル一覧の取得に失敗 — `git diff --stat ' + (evalDiffHash ?? '<eval>') + ' ' + (prDiffHash ?? '<pr>') + '` を手動確認');
    }
    lines.push('');
  } else if (evalStaleness === 'hash_reconverged') {
    lines.push('> ℹ️ **PR 直前に tree が一時乖離したが PR head tree は評価済み tree と一致**（eval ' + short8(evalDiffHash) + ' / PR 直前 ' + short8(prDiffHash) + ' / PR head ' + short8(prHeadTreeOid) + '。merge 対象 tree = 評価済み tree を決定論確認済みのため HOLD しない — eval_staleness=hash_reconverged）');
    if (Array.isArray(staleDiffFiles)) {
      lines.push('> 一時差分 ' + staleDiffFiles.length + ' 件: ' + renderDiffFiles(staleDiffFiles));
    } else {
      lines.push('> 一時差分の一覧は取得失敗');
    }
    lines.push('');
  } else if (evalStaleness === 'iterate_incomplete') {
    lines.push('> ⚠️ **pr-iterate が LGTM 以外で終端した**（fix 適用後の tree に対する再評価・LGTM が得られていない。eval/AC/security clearance の判定は現在の PR 内容を反映していない可能性がある）');
    lines.push('');
  } else if (evalStaleness === 'iterate_fixed') {
    const fixCount = (typeof iterateFixesApplied === 'number' && iterateFixesApplied >= 0) ? String(iterateFixesApplied) : '不明';
    lines.push('> ℹ️ **pr-iterate が ' + fixCount + ' 件の fix を適用して LGTM 終端**（fix 内容は pr-reviewer の再レビューで担保済み。下記の eval/AC テーブル・security clearance は fix 前 tree 基準）');
    lines.push('');
  }

  // 3. gate_policy 行
  lines.push(`gate_policy: \`${gatePolicy}\``);

  // 4. dangerHits 検出クラス行（1件以上のとき）
  if (dangerArr) {
    lines.push(`検出クラス: ${dangerArr.join(', ')}`);
  }

  // 4b. testsurfHits 検出パターン行（1件以上のとき。issue #362）
  if (testsurfArr) {
    lines.push(`検出パターン (test-weakening): ${testsurfArr.join(', ')}`);
  }

  // 4c. あなたがやること（issue #658 AC-4）。全 tier で出す。
  lines.push('');
  lines.push('### あなたがやること');
  lines.push('');
  const youDoLines = [];
  if (mergeTier === 'HOLD' && fixRequired) {
    youDoLines.push(`1. 下記「要対応」の ❌ 項目を修正して push する（レビュー再開は \`/pr-iterate ${pr}\`）`);
    youDoLines.push(`2. 再 review LGTM 後に diff を確認 → \`gh pr ready ${pr}\` → マージ`);
  } else if (mergeTier === 'HOLD' && !fixRequired && holdKind === 'deterministic_recheck') {
    youDoLines.push(`1. CI 完了 / 再取得を待って \`/pr-iterate ${pr}\` で再確認する`);
    youDoLines.push(`2. LGTM 後に diff を確認 → \`gh pr ready ${pr}\` → マージ`);
  } else if (mergeTier === 'HOLD' && !fixRequired) {
    youDoLines.push('1. 下記「HOLD になった理由と現状」を確認し、対応列が「不要」以外の行を判断する');
    youDoLines.push(`2. diff 確認 → \`gh pr ready ${pr}\` → マージ`);
  } else if (mergeTier === 'REVIEW') {
    youDoLines.push(`1. diff を review し LGTM → \`gh pr ready ${pr}\` → マージ`);
  } else {
    youDoLines.push(`1. diff を一読 → \`gh pr ready ${pr}\` → マージ`);
  }
  let youDoN = youDoLines.length + 1;
  const seenDangerClasses = new Set();
  const dangerForYouDo = Array.isArray(dangerHits) ? dangerHits : [];
  for (const cls of dangerForYouDo) {
    if (seenDangerClasses.has(cls)) continue;
    seenDangerClasses.add(cls);
    const msg = POST_MERGE_CHECK[cls] ?? `danger class "${cls}" の変更箇所の初回動作を確認する`;
    youDoLines.push(`${youDoN}. マージ後: ${msg}`);
    youDoN++;
  }
  // 4d. workflow ファイル変更検知（issue #662 レビュー: config danger class は .github/workflows/*.yml
  // に一致しないため、finalReconcile==='ci_verified' 以外の経路では workflow 変更を含んでいても
  // 「対象 workflow の初回実行確認」が出なかった）。changedFiles から直接判定する。
  const changedFilesArr = Array.isArray(changedFiles) ? changedFiles : [];
  const hasWorkflowChange = changedFilesArr.some((f) => /^\.github\/workflows\//.test(f));
  if (hasWorkflowChange) {
    youDoLines.push(`${youDoN}. マージ後: 対象 workflow の初回実行を確認する`);
    youDoN++;
  }
  if (finalReconcile === 'ci_verified') {
    youDoLines.push(`${youDoN}. マージ後: ローカルで実行できなかった検証は PR CI に委譲済み — PR CI で走らない経路（push トリガの deploy / migrate workflow 等）があれば、その初回実行を確認する`);
    youDoN++;
  }
  for (const l of youDoLines) lines.push(l);

  // 5. HOLD になった理由と現状 / Merge tier 理由（常時可視。issue #658 AC-3）
  lines.push('');
  if (mergeTier === 'HOLD' && Array.isArray(holdReasons) && holdReasons.length > 0) {
    lines.push('### HOLD になった理由と現状');
    lines.push('');
    lines.push('| 理由 | 現状 | 対応 |');
    lines.push('|---|---|---|');
    const escalateTotal = escalateAll.length;
    const escalateResolved = escalateAll.filter((it) => isResolved(it)).length;
    for (const hr of holdReasons) {
      const { current, action } = holdReasonDisplay(hr && hr.code, hr && hr.kind, {
        escalateTotal,
        escalateResolved,
        uncheckedBlockingCount: uncheckedBlocking.length,
        unsatisfiedACCount: unsatisfiedAC.length,
        unclearedCount: uncleared.length,
        iterateStatus,
        pr,
      });
      lines.push(`| ${mdCell(hr && hr.reason)} | ${current} | ${action} |`);
    }
  } else if (mergeTier === 'HOLD') {
    // fail-safe フォールバック: holdReasons が null/空でも従来どおり mergeTierReasons を列挙する。
    lines.push('**Merge tier 理由**:');
    if (!mergeTierReasons || mergeTierReasons.length === 0) {
      lines.push('- 理由記載なし');
    } else {
      for (const reason of mergeTierReasons) {
        lines.push(`- ${reason}`);
      }
    }
  } else {
    // HOLD 以外: 可視化のみの理由（disclosures）は箇条書きから除外し「参考」セクションへ回す。
    const disclosureSet = new Set(Array.isArray(disclosures) ? disclosures : []);
    const filteredReasons = (mergeTierReasons || []).filter((r) => !disclosureSet.has(r));
    lines.push('**Merge tier 理由**:');
    if (filteredReasons.length === 0) {
      lines.push('- 理由記載なし');
    } else {
      for (const reason of filteredReasons) {
        lines.push(`- ${reason}`);
      }
    }
  }

  // 5d. TESTSURF セクション（committed test の skip/削除/tautology 化 疑いを検出したときのみ表示。issue #362）
  // dangerHits/Security clearance と別系統（dimension:'test-integrity'）。hit ゼロ（testsurfHits 空 かつ
  // ledger に TESTSURF item なし）では一切出力しない（既存サマリーとの byte 同一を保つ regression 要件）。
  if (hasTestsurf) {
    lines.push('');
    lines.push('### 🧪 TESTSURF（test-weakening 検出）');
    if (testsurfClearance.length > 0) {
      lines.push('');
      lines.push('| 状態 | pattern | 内容 |');
      lines.push('|---|---|---|');
      for (const tc of testsurfClearance) {
        if (tc.cleared) {
          const evidenceCell = tc.evidence ? mdCell(tc.evidence) : '—';
          lines.push(`| ✅ cleared | ${tc.pattern} | ${evidenceCell} |`);
        } else {
          lines.push(`| ❌ 未解消 | ${tc.pattern} | **要人間確認**: committed test の skip/削除/tautology 化の疑い |`);
        }
      }
    }
  }

  // 6. 要対応セクション（常時可視。issue #658 AC-2）
  lines.push('');
  if (!hasActionItems) {
    lines.push(triagedAdvisory.length > 0 ? `### ✅ 要対応事項なし（トリアージ済み ${triagedAdvisory.length} 件）` : '### ✅ 要対応事項なし');
  } else {
    lines.push('### ⚠️ 要対応');
  }

  // ledger 未解消テーブル（(i)(ii)(iii)）。見出しに関わらず、blocking + 全 escalate + 非 escalate
  // unchecked advisory が 1 件以上あれば表を出す（escalate は解消済みでも常時表示。issue #658）。
  const ledgerActionItems = [
    ...uncheckedBlocking.map(it => ({ ...it, _lane: '必須（blocking）', _kind: 'blocking' })),
    ...escalateAll.map(it => ({ ...it, _lane: '要判断（advisory ESCALATE）', _kind: 'escalate' })),
    ...nonEscalateUnchecked.map(it => ({ ...it, _lane: '助言（advisory）', _kind: 'advisory' })),
  ];

  if (ledgerActionItems.length > 0) {
    lines.push('');
    // id 列は出さない（ledger 内部識別子はレビュアーにはノイズ。機構側は ledger データを直接参照する）
    lines.push('| 状態 | 区分 | 観点 | 内容 | 現状 | 対応 |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of ledgerActionItems) {
      const resolved = item._kind !== 'blocking' && isResolved(item);
      let status;
      if (item._kind === 'blocking') {
        status = '❌ 未解消';
      } else if (item._kind === 'escalate') {
        status = resolved ? '✅ 解消済み' : '⚠️ 要判断';
      } else {
        status = resolved ? '✅ 解消済み' : '❌ 未解消';
      }
      const dimension = item.dimension != null ? item.dimension : '—';
      let content = mdCell(item.text);
      if (item._kind === 'escalate' && nonEmpty(item.escalate_description)) {
        content += ' — ' + mdCell(item.escalate_description);
      }
      let current;
      if (item._kind === 'blocking') {
        current = item.evidence ? mdCell(item.evidence) : '未解消';
      } else if (resolved) {
        current = (item.final_resolution === 'ci_delegated' ? 'CI 委譲: ' : 'fix 後 tree で確認: ') + mdCell(item.final_evidence);
      } else if (item.final_resolution === 'unresolved' && nonEmpty(item.final_evidence)) {
        current = 'fix 後 tree でも未解消: ' + mdCell(item.final_evidence);
      } else {
        current = item.evidence ? mdCell(item.evidence) : '未解消';
      }
      let action;
      if (resolved) {
        action = '不要';
      } else if (item._kind === 'blocking') {
        action = '修正が必要';
      } else if (item._kind === 'escalate') {
        action = `要判断${item.escalate_reason ? '（' + mdCell(item.escalate_reason) + '）' : ''}`;
      } else {
        action = '任意（助言）';
      }
      lines.push(`| ${status} | ${item._lane} | ${dimension} | ${content} | ${current} | ${action} |`);
    }
  }

  if (hasActionItems) {
    // 未達 AC テーブル（(iv)）
    if (unsatisfiedAC.length > 0) {
      lines.push('');
      lines.push('| 状態 | AC | 検証 | 根拠 |');
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
      lines.push('| 状態 | danger class | 根拠 |');
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

  // 6a. トリアージ済み advisory の折りたたみ（issue #626）。要対応からは外すが、evaluator（LLM）判断の
  // 誤トリアージ検算のため 観点 / 内容 / triaged_evidence を全文で残す（件数のみに落とさない）。
  // <summary> 直後と </details> 直前の空行は GFM が details 内の table をレンダリングするために必須。
  if (triagedAdvisory.length > 0) {
    lines.push('');
    lines.push(`<details><summary>🔹 トリアージ済み ${triagedAdvisory.length} 件（evaluator 判断 — 誤トリアージ検算用）</summary>`);
    lines.push('');
    lines.push('| 観点 | 内容 | トリアージ根拠 |');
    lines.push('|---|---|---|');
    for (const item of triagedAdvisory) {
      const dimension = item.dimension != null ? item.dimension : '—';
      lines.push(`| ${dimension} | ${mdCell(item.text)} | ${mdCell(item.triaged_evidence)} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  // 6b. pr-iterate 未解消の指摘（issue #602）。iterateStatus が非 'lgtm' のときのみ描画する。
  // 出すのは終端 round（history 末尾かつ iteration === iterateIterations）の blocking findings のみ。
  // ci_error / ci_pending / review_contract_error は終端 round を history に push しないため、
  // 末尾 round の iteration が iterateIterations と一致しなければ「未解消なし」として省略する
  // （末尾 round の findings は fix → 再 review 済み）。lgtm / history 空 / findings 空では 1 行も
  // 追加しない（LGTM 終端との byte 一致を保つ regression 要件）。
  if (iterateStatus != null && iterateStatus !== 'lgtm') {
    const hist = Array.isArray(iterateHistory) ? iterateHistory : [];
    const lastRound = hist.length > 0 ? hist[hist.length - 1] : null;
    const isTerminalRound = lastRound != null
      && (typeof iterateIterations !== 'number' || lastRound.iteration === iterateIterations);
    const unresolved = isTerminalRound && Array.isArray(lastRound.blocking) ? lastRound.blocking : [];
    if (unresolved.length > 0) {
      const SEV_LABEL_LOCAL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
      lines.push('');
      lines.push(`### 🔁 pr-iterate 未解消の指摘（${unresolved.length} 件 — status: ${iterateStatus}、最終反復 ${lastRound.iteration} の review 時点）`);
      lines.push('');
      let idx = 1;
      for (const f of unresolved) {
        const sev = SEV_LABEL_LOCAL[f.severity] ?? String(f.severity ?? '不明');
        const loc = (f.file != null && f.file !== '')
          ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
          : '場所指定なし';
        lines.push(`${idx}. ${sev} — ${loc}`);
        lines.push(`   - 指摘: ${mdCell(f.description)}`);
        if (f.suggestion != null && f.suggestion !== '') {
          lines.push(`   - 提案: ${mdCell(f.suggestion)}`);
        }
        idx++;
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

  // 7. 解消済み証跡の件数行（issue #603）。全文 evidence は journal telemetry `resolved_evidence`
  // （canonical _lib/resolved-evidence.mjs、同一の選別述語）へ移した。ここでは件数だけを常時可視で出す。
  // 未解消・未 clear の item は上記「要対応」セクションに従来どおり全文で出る（AC2 / AC5）。
  const resolvedItems = [
    ...blockArr.filter(it => it.checked === true).map(it => ({ ...it, _lane: '必須（blocking）' })),
    ...advArr.filter(it => it.checked === true && it.escalate !== true && it.dimension !== 'environment').map(it => ({ ...it, _lane: '助言（advisory）' })),
  ];
  const countLines = [];
  if (resolvedItems.length > 0) countLines.push(`- ✅ Goal Ledger 解消済み ${resolvedItems.length} 件`);
  if (envItems.length > 0) countLines.push(`- 🏗 環境ノート ${envItems.length} 件（sandbox 環境事象 — 人間の対応は通常不要）`);
  if (acArr) {
    const s = acArr.filter(a => a.satisfied === true).length;
    const t = acArr.length;
    if (s > 0) countLines.push(`- ✅ 受け入れ基準 (AC) ${s}/${t} 達成`);
  }
  if (securityClearance.length > 0) {
    const c = securityClearance.filter(sc => sc.cleared === true).length;
    if (c > 0) countLines.push(`- ✅ セキュリティ確認 (Security clearance) ${c}/${securityClearance.length} 済`);
  }
  // fix 後 tree での解消確認（advisory / ESCALATE。issue #658 AC-5）。要対応表より下、この件数
  // セクションの末尾に置く（解消済み証跡セクション自体の位置は不変 — 要対応表より下のまま）。
  if (resolvedAdvisory.length > 0) countLines.push(`- ✅ fix 後 tree で解消確認 ${resolvedAdvisory.length} 件（advisory / ESCALATE — checked は不変）`);
  if (countLines.length > 0) {
    lines.push('');
    lines.push('**解消済み証跡（件数のみ — 詳細は journal telemetry `resolved_evidence`）**:');
    for (const l of countLines) lines.push(l);
  }

  // 参考（可視化のみ — merge tier 判定に不使用）。disclosures・UI 検証・Final reconcile 行を
  // ここに集約する（issue #658 AC-3）。1 行もなければセクション自体を出さない。
  const referenceLines = [];
  if (Array.isArray(disclosures)) {
    for (const line of disclosures) referenceLines.push(`- ${line}`);
  }
  if (uiVerify != null && uiVerify !== 'skipped') {
    const modeSuffix = uiVerifyMode ? ` (mode: ${uiVerifyMode})` : '';
    referenceLines.push(`- UI 検証 (ui-verify): ${uiVerify}${modeSuffix}`);
  }
  if (finalReconcile != null && finalReconcile !== 'skipped') {
    const t = finalReconcile === 'ci_verified' ? '✅ CI 委譲（PR head sha 一致・check 全 success）' : finalTestGreen === true ? '✅ green' : finalTestGreen === false ? '❌ red' : '不明';
    referenceLines.push(`- Final reconcile (pr-iterate fix 後の最終 tree 再検証): ${finalReconcile} — final test: ${t}` + (finalUiVerify != null ? `, final ui-verify: ${finalUiVerify}` : '') + (finalAcReconcile != null ? `, final AC: ${finalAcReconcile}` : ''));
    if (finalAcReconcile === 'reverified') {
      referenceLines.push('- ✅ AC は最終 PR tree で再検証済み（Final AC reconcile — AC テーブルは final snapshot）');
    } else if (finalAcReconcile !== 'reverified' && acArr) {
      referenceLines.push('- ⚠️ AC 判定は stale（fix 適用後の最終 tree に対する AC 再検証が未実施/判定不能 — AC テーブルは Evaluate 時点（fix 前 tree）基準であり final ではない）');
    }
  }
  if (referenceLines.length > 0) {
    lines.push('');
    lines.push('**参考（可視化のみ — merge tier 判定に不使用）**:');
    for (const l of referenceLines) lines.push(l);
  }

  // 8b. lite レビュー統合セクション（issue #392 AC-6）
  // liteReview が非 null の場合のみ描画する。既存の post-review-lite が独立コメントで
  // 出していた decision / CI status / summary を dev-flow 終端サマリーへ統合する。
  // null/undefined 時は 1 行も追加せず既存出力と byte 一致を維持する（回帰保証）。
  if (liteReview != null) {
    lines.push('');
    lines.push('### lite レビュー（pr-iterate 起動なし）');
    lines.push('');
    lines.push(`- **decision**: ${liteReview.decision ?? 'n/a'}`);
    lines.push(`- **CI**: ${liteReview.ci}`);
    if (liteReview.summary != null && liteReview.summary !== '') {
      lines.push(`- **総評**: ${mdCell(liteReview.summary)}`);
    }
  }

  // 9. 末尾
  lines.push('');
  lines.push('---');
  lines.push('*このコメントは dev-flow により自動生成されました。*');
  lines.push(`<!-- dev-flow:${mergeTier} -->`);

  return lines.join('\n');
}

// HOLD 理由 code -> {現状, 対応} の fail-safe 写像（issue #658）。merge-tier.mjs の
// HOLD_REASON_CODES を canonical とする（import 不可のため重複定義。同値性は
// _lib/final-ci-routing.test.mjs 系と同じ規約で運用側が pin する）。out-of-enum / 欠落は
// throw せず '—' / '人が確認する' に落とす（表示専用フィールドのため）。
function holdReasonDisplay(code, kind, ctx) {
  switch (code) {
    case 'escalate': {
      const { escalateTotal, escalateResolved } = ctx;
      return {
        current: `ESCALATE ${escalateTotal} 件中 ${escalateResolved} 件は fix 後 tree で解消確認済み`,
        action: escalateTotal === escalateResolved ? '不要（マージ可否の判断のみ）' : `要判断 ${escalateTotal - escalateResolved} 件（下表 ⚠️ 行）`,
      };
    }
    case 'ledger_unconverged':
      return { current: `未 checked blocking ${ctx.uncheckedBlockingCount} 件`, action: '修正が必要（下表 ❌ 行）' };
    case 'ac_unsatisfied':
      return { current: `AC 未達 ${ctx.unsatisfiedACCount} 件`, action: '修正が必要（下表 ❌ 未達 行）' };
    case 'danger_unresolved':
      return { current: `security clearance 未確認 ${ctx.unclearedCount} 件`, action: '人が該当 diff を確認する' };
    case 'danger_fail_closed':
      return { current: 'danger-grep 実行不能（security 未検証）', action: 'danger-grep を手動実行して確認する' };
    case 'breaking_structured':
      return { current: 'analyze が breaking_change=true と判定', action: '互換性影響と告知要否を判断する' };
    case 'final_reconcile_unavailable':
      return kind === 'deterministic_recheck'
        ? { current: 'CI 完了待ち / 再取得で解消しうる', action: 'CI 完了後に再確認する' }
        : { current: '最終 tree のテスト状態が未確認', action: '最終 tree でテストを手動実行する' };
    case 'final_test_red':
      return { current: 'fix 後の最終 tree でテスト失敗', action: '修正が必要' };
    case 'final_ac_unavailable':
      return { current: '最終 tree の AC 再検証結果を取得できず', action: 'AC を手動で再確認する' };
    case 'iterate_non_lgtm':
      return { current: `pr-iterate status=${ctx.iterateStatus ?? 'null'}`, action: `未解消指摘を修正する（\`/pr-iterate ${ctx.pr}\` 単体起動で回収可）` };
    case 'hash_mismatch':
      return { current: '評価済み tree と PR tree が乖離', action: '差分を確認し必要なら再評価する' };
    case 'testsurf_uncleared':
      return { current: 'test-weakening 未クリア', action: '該当テスト変更の正当性を確認する' };
    case 'mergeable_conflicting':
      return { current: 'base branch と conflict', action: 'conflict を解消して push する' };
    case 'trust_gate':
      return { current: 'EvalSeal receipt 非 pass', action: '人が確認する' };
    default:
      return { current: '—', action: '人が確認する' };
  }
}
