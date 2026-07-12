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
const FINAL_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable'];

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
// s.iterateStatus (string|null): pr-iterate の終端 status（'lgtm'|'stuck'|'fix_failed'|
//   'max_reached'|'ci_error'|'ci_pending'|null）。'lgtm' 以外（未知値・null 含む）は
//   決定論的 HOLD（fail-safe、allowlist しない厳格判定）。blast-radius クラス（issue #319）—
//   merge 直前の最終ゲートが LGTM 未到達のまま AUTO/REVIEW を出すと既知の指摘が未解消のまま
//   出荷されるため、gate_policy で緩和しない（軸A 不変）。
// s.evalStaleness (string): 'none'|'hash_mismatch'|'iterate_incomplete'|'iterate_fixed'
//   （issue #288 の 4 値）。'hash_mismatch' のみ HOLD 追加（Evaluate 対象 tree と PR tree の
//   乖離）。'iterate_incomplete' は iterateStatus !== 'lgtm' と必ず同時発生するため個別条件に
//   しない。'none'/'iterate_fixed' は tier に影響しない。
export function classifyMergeTier(s) {
  if (s.finalReconcile != null && !FINAL_RECONCILE_VALUES.includes(s.finalReconcile)) {
    throw new Error('classifyMergeTier: invalid finalReconcile: ' + s.finalReconcile);
  }
  const reasons = [];
  if (!s.converged) reasons.push('ledger 未収束（未 checked blocking 残）');
  if (s.unresolvedDanger) reasons.push('danger-grep hit 未解消（security 要確認）');
  if (s.breakingStructured) reasons.push('breaking/migration 検出（analyze 構造化判定 breaking_change=true）');
  if (s.breakingKeyword) reasons.push('breaking/migration 検出（issue title/body keyword scan 決定論 hit）');
  if (s.escalateCount > 0) reasons.push(`ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`);
  if (s.unsatisfiedAc) reasons.push('AC 未達（acceptance_criteria が satisfied:false — gate_policy に依らず人間確認必須）');
  if (s.dangerFailClosed === true) reasons.push('danger-grep 実行不能（fail-closed）— security 未検証のため人間確認必須');
  if (s.finalReconcile === 'unavailable') reasons.push('Final reconcile 再検証不能（pr-iterate fix 適用後の最終 tree の test 状態を確認できず）— 人間確認必須');
  if (s.finalTestGreen === false) reasons.push('final test red（pr-iterate fix 適用後の最終 tree でテスト失敗）');
  if (s.iterateStatus !== 'lgtm') reasons.push(`pr-iterate 非LGTM終端（status=${s.iterateStatus ?? 'null'}）— review⇄fix loop が LGTM 未到達のため人間確認必須（gate_policy に依らず不変）`);
  if (s.evalStaleness === 'hash_mismatch') reasons.push('Evaluate 時点と PR 直前の diff hash 不一致（eval_staleness=hash_mismatch）— 評価済み tree と merge 対象 tree が乖離しており人間確認必須（gate_policy に依らず不変）');
  if (reasons.length) return { tier: 'HOLD', reasons };
  if (s.shape === 'micro' && s.docsOrTestOnly) {
    const autoReasons = ['micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）'];
    // micro path は evaluator 0 回で AC を判定していない — AUTO 推奨でもその事実を開示する（issue #233）。
    // evalSkipped は optional（未指定 = falsy = 開示なし）。tier 判定値は変更しない（ゲート境界不変）。
    if (s.evalSkipped === true) autoReasons.push('AC は未検証（micro eval skip）— evaluator 0 回のため acceptance_criteria の充足は判定していない');
    return { tier: 'AUTO', reasons: autoReasons };
  }
  return { tier: 'REVIEW', reasons: ['標準 — 人間が LGTM して merge'] };
}
