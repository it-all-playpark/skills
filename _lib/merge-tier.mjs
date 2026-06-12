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

// danger-grep の hit クラス集合で SEC seed item を解決する。
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
export function reconcileDanger(ledger, hitClasses) {
  const hits = new Set(hitClasses);
  const items = ledger.items.map((it) => {
    if (it.source !== 'seed' || it.dimension !== 'security') return it;
    if (hits.has(it.danger_class)) {
      // floor=true かつ checked=true → evaluator が danger floor を evidence 付きで clearance 済み。
      // 同クラスが依然 hit でも checked を維持して HOLD に巻き戻さない。
      // floor=false かつ checked=true → 前回 reconcile で "danger-grep clean" 自動解決されたが
      // 今回 hit に転じた(pr-iterate で増えた) → 再度 unchecked にして block を復活させる。
      if (it.checked && it.floor) return it;
      return { ...it, severity: 'critical', floor: true, checked: false };
    }
    return { ...it, checked: true, evidence: 'danger-grep clean' };
  });
  return { ...ledger, items };
}

// 変更ファイルが docs(.md/.mdx/.txt, docs/) か test(*test*, *spec*, .bats) のみか。
export function isDocsOrTestOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) =>
    /\.(md|mdx|txt)$/i.test(f) || /(^|\/)docs\//i.test(f)
    || /(^|\/|\.)(test|spec)([./]|$)/i.test(f) || /\.bats$/i.test(f));
}

// merge tier を算出する。merge は全 tier 人間(AUTO も推奨ラベルのみ。真 auto-merge は W6)。
// HOLD: 未収束 / 未解消 danger / breaking / ESCALATE 項目あり（人間 required-block）。
// AUTO: micro かつ docs/test-only かつ danger clean かつ収束（推奨ラベル）。
// REVIEW: それ以外（標準。人間が LGTM して merge）。
// s.evalSkipped (optional boolean): true の場合、AUTO branch で AC 未検証開示 reason を追記する。
//   micro path は evaluator 0 回で AC を判定していないため、AUTO 推奨でもその事実を開示する（issue #233）。
//   danger-grep hit / green-fix で security path により eval が強制実行された場合は false にして虚偽開示を避ける。
export function classifyMergeTier(s) {
  const reasons = [];
  if (!s.converged) reasons.push('ledger 未収束（未 checked blocking 残）');
  if (s.unresolvedDanger) reasons.push('danger-grep hit 未解消（security 要確認）');
  if (s.breaking) reasons.push('breaking/migration 検出');
  if (s.escalateCount > 0) reasons.push(`ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`);
  if (s.unsatisfiedAc) reasons.push('AC 未達（acceptance_criteria が satisfied:false — gate_policy に依らず人間確認必須）');
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
