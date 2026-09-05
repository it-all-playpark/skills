// dev-flow W5: merge tiering + 決定論 danger floor の純粋関数群。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// diff-risk-classify.sh が出力する 7 danger クラス（固定順）。
export const DANGER_CLASSES = [
  'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
];

const SEC_TEXT = {
  'auth': '認証/認可ファイルの変更が安全か（権限昇格・認可バイパスなし）',
  'crypto': '暗号処理の変更が安全か（弱いアルゴリズム・鍵漏洩なし）',
  'config': 'config/secret の変更が安全か（秘密情報の平文混入なし）',
  'data-migration': 'data migration が安全か（不可逆・データ欠損なし）',
  'public-api': 'public API 変更が後方互換か（破壊的変更の明示）',
  'exec-sink': 'exec/deserialization sink が安全か（任意コード実行なし）',
  'dependency': '依存追加が安全か（既知脆弱性・supply chain リスクなし）',
};

// 7 danger クラスを常時 blocking seed する。danger-grep clean なら reconcileDanger が
// 自動 check し、hit したクラスは critical へ raise して block 据え置きにする。
export function seedSecurityLedger() {
  return DANGER_CLASSES.map((cls) => ({
    id: `SEC-${cls.toUpperCase()}`,
    text: SEC_TEXT[cls],
    dimension: 'security',
    severity: 'major',
    source: 'seed',
    check: { kind: 'deterministic' },
    danger_class: cls,
  }));
}

// danger-grep の結果で SEC seed item を解決する。
// risk.ok !== true は danger-grep 実行失敗/転写失敗/空出力を表し、fail-closed として
// 全 SEC seed を unchecked に戻す（clean と区別する）。この際 fail_closed:true を付与する
// （danger_hits とは別軸の機械可読フラグ。Evaluate ループ収束判定からのみ除外するために使う。
// merge tier 側は unchecked のまま含めて HOLD を強制し続ける — security floor は緩めない）。
// clean/hit の成功分岐では fail_closed:false を明示セットして stale フラグを解消する。
// clean クラス → checked(evidence='danger-grep clean')。
// hit クラス → critical へ raise(floor=true)。
//   - floor=true かつ checked=true(evaluator が evidence で clearance 済み) → checked を維持する(HOLD に巻き戻さない)。
//   - floor=false かつ checked=true(前回 "danger-grep clean" 自動解決済み) → 今回 hit に転じたので unchecked 復活。
//   - checked=false → checked=false 据え置き(evaluator が次ラウンドで解消するまで block)。
// SEC 以外の item は touch しない。
//
// 再 reconcile ポリシー(pr-iterate 後の Merge tier phase での呼び出しを含む):
//   danger が増えた(新クラスが hit に転じた)場合 → floor=false なので unchecked 復活 = HOLD。
//   danger が減った(以前 hit だったクラスが clean に転じた)場合 → checked=true に解放(自動解消)。
//   danger が同じ hit クラスで残る かつ evaluator clearance 済み(floor=true, checked=true) → checked 維持(温存)。
export function reconcileDanger(ledger, risk) {
  if (!risk || risk.ok !== true) {
    // ツール欠落/スクリプト実行不能/JSON 不正などによる fail-closed。
    // 実際の danger 検出（risk.ok:true + hits）とは語彙を分け、
    // operator が log と HOLD reason から「danger を検出したのか」「ツールが走らなかったのか」を判別できるようにする。
    const errDetail = risk?.error ? `: ${risk.error}` : '';
    const evidence = `danger-grep unavailable (fail-closed)${errDetail}`;
    const items = ledger.items.map((it) => {
      if (it.source !== 'seed' || it.dimension !== 'security') return it;
      return { ...it, checked: false, fail_closed: true, evidence };
    });
    return { ...ledger, items };
  }

  const hits = new Set((risk.hits ?? []).map((h) => h.class));
  const items = ledger.items.map((it) => {
    if (it.source !== 'seed' || it.dimension !== 'security') return it;
    if (hits.has(it.danger_class)) {
      // floor=true かつ checked=true → evaluator が danger floor を evidence 付きで clearance 済み。
      // 同クラスが依然 hit でも checked を維持して HOLD に巻き戻さない。
      // floor=false かつ checked=true → 前回 reconcile で "danger-grep clean" 自動解決されたが
      // 今回 hit に転じた(pr-iterate で増えた) → 再度 unchecked にして block を復活させる。
      if (it.checked && it.floor) return it;
      // evidence を null クリアする。前回 reconcile が "danger-grep clean" 等で自動 check した
      // stale evidence を残すと、unchecked/critical に戻った item に矛盾した evidence 表示が残る。
      return { ...it, severity: 'critical', floor: true, checked: false, fail_closed: false, evidence: null };
    }
    return { ...it, checked: true, fail_closed: false, evidence: 'danger-grep clean' };
  });
  return { ...ledger, items };
}

// Merge tier phase で reconcileDanger 前後の SEC ledger を比較し、one-shot security
// clearance の対象候補を決定論的に算出する純関数。
// 「before で checked（Evaluate 時点等で解消済み）だったが after で unchecked に転じた」
// SEC seed item の danger_class のみを返す（Evaluate 時点から未解消のまま残る SEC は
// merge tier で clear させない = security floor 不変）。
// after 側で fail_closed:true の item は defense-in-depth として除外する（fail-closed 時は
// clearance 対象にしない）。before に同 id が無い item も対象外。ledger は mutate しない。
export function newlyUncheckedSecClasses(before, after) {
  const beforeById = new Map(
    (before?.items ?? [])
      .filter((it) => it.source === 'seed' && it.dimension === 'security')
      .map((it) => [it.id, it]),
  );
  const result = [];
  for (const it of (after?.items ?? [])) {
    if (it.source !== 'seed' || it.dimension !== 'security') continue;
    if (it.fail_closed === true) continue;
    const prev = beforeById.get(it.id);
    if (!prev) continue;
    if (prev.checked === true && it.checked !== true) {
      result.push(it.danger_class);
    }
  }
  return result;
}

// 変更ファイルが docs(.md/.mdx/.txt, docs/) か test(*test*, *spec*, .bats) のみか。
export function isDocsOrTestOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) =>
    /\.(md|mdx|txt)$/i.test(f) || /(^|\/)docs\//i.test(f)
    || /(^|\/|\.)(test|spec)([./]|$)/i.test(f) || /\.bats$/i.test(f));
}

// Final reconcile（pr-iterate fix 適用後の最終 tree 再検証、issue #320）の finalReconcile enum。
// 'skipped': fixes_applied=0 で Final reconcile 自体を実行しなかった（zero-overhead routing）。
// 'reverified': 最終 tree に対して sync + test 再実行を行った。
// 'unavailable': worktree sync 失敗 / test agent null・schema 不一致等で再検証結果を取得できなかった
//   （fail-safe。HOLD へ倒す）。
// 'ci_verified': ローカル再検証は不能だったが、PR head sha に pin した CI check（finalCiVerdict、
//   _lib/final-ci.mjs）が sha 一致かつ全 success で最終 tree の test 状態を検証済みとして扱う
//   （issue #599）。
const FINAL_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable', 'ci_verified'];

// merge tier HOLD 理由の分類（issue #599）。'deterministic_recheck': 決定論的な再チェック
// （CI 完了待ち・再取得等）で解消しうる。'human_judgment': 決定論的手段では解消できず人間確認が
// 必須。_lib/final-ci.mjs の FINAL_CI_KIND_* と同値。canonical は import 不可のため重複定義し、
// 同値性は _lib/final-ci-routing.test.mjs が pin する。
export const HOLD_REASON_KINDS = ['deterministic_recheck', 'human_judgment'];

// HOLD 理由配列（[{ reason, kind }]）から代表 kind を集約する純関数。
// いずれかが 'human_judgment' なら 'human_judgment'（human 判断が 1 件でもあれば全体を human 扱いにする
// fail-closed 側の集約）。全件 'deterministic_recheck' ならそのまま。空/非配列は null（HOLD 以外）。
export function aggregateHoldKind(holdReasons) {
  if (!Array.isArray(holdReasons) || holdReasons.length === 0) return null;
  if (holdReasons.some((r) => r.kind === 'human_judgment')) return 'human_judgment';
  return 'deterministic_recheck';
}

// gh pr view --json mergeable,mergeStateStatus の生出力を 3 値 enum に写像する pure 関数。
// 'conflicting': base branch と conflict（mergeable=CONFLICTING もしくは mergeStateStatus=DIRTY）。
// 'clean': mergeable=MERGEABLE かつ conflict なし。
// 'unknown': proxy 失敗（ok!==true / null）または GitHub が mergeability 未計算（UNKNOWN 等）。
//   fail-open — conflict gate を適用しない（後述 classifyMergeTier で reason 追加なし）。
export function classifyMergeableState(meta) {
  if (!meta || meta.ok !== true) return 'unknown';
  const ms = String(meta.mergeStateStatus ?? '').toUpperCase();
  const mg = String(meta.mergeable ?? '').toUpperCase();
  if (mg === 'CONFLICTING' || ms === 'DIRTY') return 'conflicting';
  if (mg === 'MERGEABLE') return 'clean';
  return 'unknown';
}

// merge tier を算出する。merge は全 tier 人間(AUTO も推奨ラベルのみ。真 auto-merge は W6)。
// HOLD: 未収束 / 未解消 danger / breaking / ESCALATE 項目あり（人間 required-block）。
// breaking は analyze 構造化判定 (breakingStructured) と issue title/body keyword scan
// (breakingKeyword) の 2 入力で、reason で由来を区別する（issue #278）。
// AUTO: micro かつ docs/test-only かつ danger clean かつ収束（推奨ラベル）。
// REVIEW: それ以外（標準。人間が LGTM して merge）。
// s.evalSkipped (optional boolean): true の場合、AUTO branch で AC 未検証開示 reason を追記する。
//   micro path は evaluator 0 回で AC を判定していないため、AUTO 推奨でもその事実を開示する（issue #233）。
//   danger-grep hit / green-fix で security path により eval が強制実行された場合は false にして虚偽開示を避ける。
// s.dangerFailClosed (optional boolean): true の場合、danger-grep が実行不能（fail-closed）だったことを
//   示す専用 HOLD reason を追記する（issue #271）。fail-closed 時は SEC seed item が unchecked のまま
//   残るため s.converged が既に false になり HOLD へ落ちるが、この reason は「なぜ未収束か」を
//   security 不明という意味論で明示するための defense-in-depth（danger_hits の実 hit とは別軸）。
//   未指定 = falsy = reason 追加なし、tier 判定値も従来と完全同一（regression なし）。
// s.finalReconcile (optional 'skipped'|'reverified'|'unavailable'): Final reconcile phase の実行結果
//   （issue #320）。'unavailable' は fail-safe HOLD reason を追記する。out-of-enum は明示 error
//   （後方互換 scaffolding 禁止規約）。未指定(undefined/null) = reason 追加なし。
// s.finalTestGreen (optional true|false|null): Final reconcile での最終 tree test 再実行結果。
//   false のとき専用 HOLD reason を追記する。true/null(未実行 or no_tests)は reason 追加なし。
// s.breakingStructured / s.breakingKeyword: breaking 検出は analyze 構造化判定
//   (breakingStructured = breaking_change===true) と issue title/body keyword scan
//   (breakingKeyword) の 2 入力を持つ（issue #278）。ただし breakingKeyword は単独では
//   HOLD にしない（issue #364 precision fix）。issue 本文への keyword grep は変更の
//   破壊性を担保する oracle ではなく低 precision ヒューリスティック（実測 FP: #359/#361）
//   であり、構造化判定との corroboration があるときのみ blocking 理由に採用する。
//   keyword-alone（breakingKeyword && !breakingStructured）のときは tier/shape を
//   変えない可視化 reason を末尾に追記するのみ。コード実体に対する決定論 breaking 検出は
//   danger-grep 'public-api' クラス（realized diff 上、blast-radius floor）が別途担保する。
// s.iterateStatus (string|null): pr-iterate の終端 status（'lgtm'|'stuck'|'fix_failed'|
//   'max_reached'|'ci_error'|'ci_pending'|null）。'lgtm' 以外（未知値・null 含む）は
//   決定論的 HOLD（fail-safe、allowlist しない厳格判定）。blast-radius クラス（issue #319）—
//   merge 直前の最終ゲートが LGTM 未到達のまま AUTO/REVIEW を出すと既知の指摘が未解消のまま
//   出荷されるため、gate_policy で緩和しない（軸A 不変）。
// s.evalStaleness (string): 'none'|'hash_mismatch'|'iterate_incomplete'|'iterate_fixed'
//   （issue #288 の 4 値）。'hash_mismatch' のみ HOLD 追加（Evaluate 対象 tree と PR tree の
//   乖離）。'iterate_incomplete' は iterateStatus !== 'lgtm' と必ず同時発生するため個別条件に
//   しない。'none'/'iterate_fixed' は tier に影響しない。
// s.finalAcReconcile (optional 'skipped'|'reverified'|'unavailable'): Final AC reconcile phase
//   （issue #331）の実行結果。fix 適用 run での既存 AC の最終 PR tree に対する再検証結果。
//   'unavailable' のみ専用 HOLD reason を追記する（軸A 決定論ゲート、gate_policy に依らず不変）。
//   'skipped'/'reverified'/未指定は tier 判定不変（fail/pass の gating は unsatisfiedAc と
//   ledger 未収束が担う）。未指定 = 従来と完全同一挙動（regression なし）。out-of-enum は明示 error
//   （後方互換 scaffolding 禁止規約）。
// s.testsurfUncleared (optional string[]): 未 checked の TESTSURF-* seed item id 一覧（issue #362）。
//   非空時に専用 HOLD reason を defense-in-depth として追記する（dangerFailClosed reason と同型の
//   可視化）。TESTSURF item は source:'seed' の unchecked のまま converged=false → HOLD は既に成立
//   しているため、この reason は tier 判定値そのものは変えない。未指定/空 = reason 追加なし
//   （regression なし）。
// s.mergeableState (optional 'clean'|'conflicting'|'unknown'): classifyMergeableState() が
//   gh pr view --json mergeable,mergeStateStatus を写像した結果（issue #405）。'conflicting' は
//   他条件によらず無条件 HOLD reason を追記する（blast-radius クラス、gate_policy に依らず不変 —
//   base branch と conflict した状態で AUTO/REVIEW を出すと merge 不能な PR を出荷することになる）。
//   'clean'/'unknown'/未指定は reason 追加なし（fail-open no-op、regression なし）。'unknown' は
//   proxy 失敗や GitHub 側 mergeability 未計算を含むため conflict と決めつけない。out-of-enum は
//   明示 error（後方互換 scaffolding 禁止規約）。
// s.trustGate (optional { blocking: true, verdict: 'pass'|'fail'|'inconclusive' }): EvalSeal
//   receipt の trust-layer blocking 昇格経路（epic #390 Phase 3, issue #411）。現行 config は
//   shadow 固定のため live 呼び出しは常に null（isGatingMode(mode) が true のときのみ workflow
//   が non-null を渡す設計）— 未指定/null = 挙動完全不変（regression なし）。non-null かつ
//   blocking===true かつ verdict!=='pass' のとき HOLD reason を追記する（inconclusive も成功
//   扱いしない）。verdict が closed enum 外は throw（後方互換 scaffolding 禁止規約）。
//   issue #507 で trust-layer 生産側（call site / exec-proxy）は撤去済みのため、live 呼び出しは
//   常に null を給電し、この HOLD 分岐は現在到達不能。blocking 昇格（rules/dev-flow.md の
//   sunset path）時の将来接続点として意図的に存置する。経路の存続は
//   _lib/trust-kernel-invariant.test.mjs が pin する。
// s.evalVerdictFail (optional boolean): true の場合、evaluate phase が verdict=fail のまま PR へ
//   進んだ事実を開示する専用 reason を HOLD/AUTO/REVIEW 全分岐の reasons に追記する
//   （keywordAloneDisclosure と同型 — issue #536）。未解消 findings は ledger/HOLD 条件が別途
//   担保するため tier 判定値は変えない（可視化のみ）。未指定/null/false = reason 追加なし、
//   tier 判定値も従来と完全同一（regression なし）。boolean 以外は明示 error
//   （後方互換 scaffolding 禁止規約）。
// s.finalCi (optional { verified: boolean, reason: string, kind: string|null, checkNames: string[],
//   headRefOid: string|null }): finalCiVerdict（_lib/final-ci.mjs）の返り値そのもの（issue #599）。
//   s.finalReconcile === 'unavailable' のとき、ローカル再検証は不能だったが PR head sha に pin した
//   CI check で代替検証できたかを表す。finalCi が無ければ従来どおりの「人間確認必須」文言のまま
//   HOLD reason を追記する。finalCi があれば reason に CI 委譲の不成立理由（reason/checkNames）を
//   追記し、kind（finalCi.kind ?? 'human_judgment'）に応じて「決定論再チェックで解消しうる」か
//   「人間確認必須」かを文言で区別する。s.finalReconcile === 'ci_verified' のときは HOLD reason を
//   一切積まず、代わりに ciVerifiedDisclosure（HOLD/AUTO/REVIEW 全分岐共通の可視化行）のみ追記する
//   （tier 判定値は変えない）。検証: finalCi.verified が boolean でなければ throw。finalCi.kind が
//   HOLD_REASON_KINDS 外なら throw。finalReconcile==='ci_verified' なのに finalCi.verified!==true
//   なら throw（証拠なしに ci_verified を名乗らせない fail-closed）。未指定(undefined/null) = 従来と
//   完全同一挙動（regression なし）。
// 返り値: { tier, reasons, holdReasons, holdKind }（issue #599 で holdReasons/holdKind を追加）。
//   reasons は従来どおり string[]（HOLD 時は blocking 文言 + 可視化行、AUTO/REVIEW 時は従来文言 +
//   可視化行）。holdReasons は HOLD 時のみ blocking 文言の [{ reason, kind }]（可視化行は含めない）、
//   AUTO/REVIEW 時は []。holdKind は aggregateHoldKind(holdReasons)（HOLD 以外は null）。
export function classifyMergeTier(s) {
  if (s.finalReconcile != null && !FINAL_RECONCILE_VALUES.includes(s.finalReconcile)) {
    throw new Error('classifyMergeTier: invalid finalReconcile: ' + s.finalReconcile);
  }
  if (s.finalAcReconcile != null && !['skipped', 'reverified', 'unavailable'].includes(s.finalAcReconcile)) {
    throw new Error('classifyMergeTier: invalid finalAcReconcile: ' + s.finalAcReconcile);
  }
  if (s.mergeableState != null && !['clean', 'conflicting', 'unknown'].includes(s.mergeableState)) {
    throw new Error('classifyMergeTier: invalid mergeableState: ' + s.mergeableState);
  }
  if (s.trustGate != null && !['pass', 'fail', 'inconclusive'].includes(s.trustGate.verdict)) {
    throw new Error('classifyMergeTier: invalid trustGate: ' + s.trustGate.verdict);
  }
  if (s.evalVerdictFail != null && typeof s.evalVerdictFail !== 'boolean') {
    throw new Error('classifyMergeTier: invalid evalVerdictFail: ' + s.evalVerdictFail);
  }
  if (s.finalCi != null && typeof s.finalCi.verified !== 'boolean') {
    throw new Error('classifyMergeTier: invalid finalCi');
  }
  if (s.finalCi != null && s.finalCi.kind != null && !HOLD_REASON_KINDS.includes(s.finalCi.kind)) {
    throw new Error('classifyMergeTier: invalid finalCi.kind: ' + s.finalCi.kind);
  }
  if (s.finalReconcile === 'ci_verified' && (s.finalCi == null || s.finalCi.verified !== true)) {
    throw new Error('classifyMergeTier: finalReconcile=ci_verified requires finalCi.verified===true');
  }
  // blocking 文言のみ（可視化行は含めない）。HOLD 判定・holdReasons/holdKind の入力に使う。
  const blockingReasons = [];
  const pushBlocking = (reason, kind) => blockingReasons.push({ reason, kind });
  if (!s.converged) pushBlocking('ledger 未収束（未 checked blocking 残）', 'human_judgment');
  if (s.unresolvedDanger) pushBlocking('danger-grep hit 未解消（security 要確認）', 'human_judgment');
  if (s.breakingStructured) {
    pushBlocking('breaking/migration 検出（analyze 構造化判定 breaking_change=true'
      + (s.breakingKeyword ? ' + issue title/body keyword scan hit' : '') + '）', 'human_judgment');
  }
  const keywordAloneDisclosure = (s.breakingKeyword && !s.breakingStructured)
    ? 'breaking keyword hit（issue title/body 決定論 scan）— 構造化判定 breaking_change=false のため HOLD 不採用（可視化のみ。issue #364）'
    : null;
  const evalFailDisclosure = s.evalVerdictFail === true
    ? 'evaluator verdict=fail のまま PR へ進行 — 未解消 findings は ledger/HOLD 条件が別途担保するため tier 判定は不変（可視化のみ。issue #536）'
    : null;
  const ciVerifiedDisclosure = s.finalReconcile === 'ci_verified'
    ? 'Final reconcile はローカル再検証不能だったが PR head sha ' + s.finalCi.headRefOid
      + ' の CI check 全 success を決定論確認（final_reconcile=ci_verified: ' + s.finalCi.checkNames.join(', ')
      + '）— test gate は CI 委譲で充足（issue #599）'
    : null;
  if (s.escalateCount > 0) pushBlocking(`ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`, 'human_judgment');
  if (s.unsatisfiedAc) pushBlocking('AC 未達（acceptance_criteria が satisfied:false — gate_policy に依らず人間確認必須）', 'human_judgment');
  if (s.dangerFailClosed === true) pushBlocking('danger-grep 実行不能（fail-closed）— security 未検証のため人間確認必須', 'human_judgment');
  if (s.finalReconcile === 'unavailable') {
    if (s.finalCi == null) {
      pushBlocking('Final reconcile 再検証不能（pr-iterate fix 適用後の最終 tree の test 状態を確認できず）— 人間確認必須', 'human_judgment');
    } else {
      const kind = s.finalCi.kind ?? 'human_judgment';
      const reason = 'Final reconcile 再検証不能（pr-iterate fix 適用後の最終 tree の test 状態を確認できず）— CI 委譲も不成立（reason=' + s.finalCi.reason
        + (s.finalCi.checkNames.length ? ': ' + s.finalCi.checkNames.join(', ') : '') + '）— '
        + (kind === 'deterministic_recheck' ? '決定論再チェック（CI 完了待ち / 再取得）で解消しうる' : '人間確認必須');
      pushBlocking(reason, kind);
    }
  }
  if (s.finalTestGreen === false) pushBlocking('final test red（pr-iterate fix 適用後の最終 tree でテスト失敗）', 'human_judgment');
  if (s.finalAcReconcile === 'unavailable') pushBlocking('Final AC reconcile 判定不能（最終 PR tree に対する AC 再検証結果を取得できず — agent null / schema 不一致 / index 欠落・重複・範囲外 / evidence 不足）— 人間確認必須（gate_policy に依らず不変）', 'human_judgment');
  if (s.iterateStatus !== 'lgtm') pushBlocking(`pr-iterate 非LGTM終端（status=${s.iterateStatus ?? 'null'}）— review⇄fix loop が LGTM 未到達のため人間確認必須（gate_policy に依らず不変）`, 'human_judgment');
  if (s.evalStaleness === 'hash_mismatch') pushBlocking('Evaluate 時点と PR 直前の diff hash 不一致（eval_staleness=hash_mismatch）— 評価済み tree と merge 対象 tree が乖離しており人間確認必須（gate_policy に依らず不変）', 'human_judgment');
  if (Array.isArray(s.testsurfUncleared) && s.testsurfUncleared.length > 0) {
    pushBlocking(`test-weakening 検出が未クリア（${s.testsurfUncleared.join(', ')}）: committed test の skip/削除/tautology 化の疑い。evaluator clearance か人間確認が必要`, 'human_judgment');
  }
  if (s.mergeableState === 'conflicting') pushBlocking('base branch と conflict（mergeStateStatus=DIRTY / mergeable=CONFLICTING）— merge 前に conflict 解消が必要（人間確認必須。gate_policy に依らず不変）', 'human_judgment');
  if (s.trustGate != null && s.trustGate.blocking === true && s.trustGate.verdict !== 'pass') {
    pushBlocking(`EvalSeal receipt 非 pass（verdict=${s.trustGate.verdict}）— trust-layer blocking 昇格後の HOLD route（epic #390 Phase 3。inconclusive は成功扱いしない）`, 'human_judgment');
  }
  if (blockingReasons.length) {
    const reasons = blockingReasons.map((r) => r.reason);
    if (keywordAloneDisclosure) reasons.push(keywordAloneDisclosure);
    if (evalFailDisclosure) reasons.push(evalFailDisclosure);
    if (ciVerifiedDisclosure) reasons.push(ciVerifiedDisclosure);
    return { tier: 'HOLD', reasons, holdReasons: blockingReasons, holdKind: aggregateHoldKind(blockingReasons) };
  }
  if (s.shape === 'micro' && s.docsOrTestOnly) {
    const autoReasons = ['micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）'];
    // micro path は evaluator 0 回で AC を判定していない — AUTO 推奨でもその事実を開示する（issue #233）。
    // evalSkipped は optional（未指定 = falsy = 開示なし）。tier 判定値は変更しない（ゲート境界不変）。
    if (s.evalSkipped === true) autoReasons.push('AC は未検証（micro eval skip）— evaluator 0 回のため acceptance_criteria の充足は判定していない');
    if (keywordAloneDisclosure) autoReasons.push(keywordAloneDisclosure);
    if (evalFailDisclosure) autoReasons.push(evalFailDisclosure);
    if (ciVerifiedDisclosure) autoReasons.push(ciVerifiedDisclosure);
    return { tier: 'AUTO', reasons: autoReasons, holdReasons: [], holdKind: null };
  }
  const reviewReasons = ['標準 — 人間が LGTM して merge'];
  if (keywordAloneDisclosure) reviewReasons.push(keywordAloneDisclosure);
  if (evalFailDisclosure) reviewReasons.push(evalFailDisclosure);
  if (ciVerifiedDisclosure) reviewReasons.push(ciVerifiedDisclosure);
  return { tier: 'REVIEW', reasons: reviewReasons, holdReasons: [], holdKind: null };
}
