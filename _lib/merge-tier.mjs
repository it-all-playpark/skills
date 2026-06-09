// dev-flow W5: merge tiering + 決定論 danger floor の純粋関数群。
//
// INLINE COPY POLICY: .claude/workflows/dev-flow.js は dynamic workflow ローダーが
// 独自 VM で評価するため ESM import 不可。本ファイルの関数は dev-flow.js に inline
// コピーされ、_lib/merge-tier.sync.test.mjs が byte 一致を CI で保証する。
// 修正時は必ず dev-flow.js の inline コピーも同期すること。

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

const SEC_SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };

// danger-grep の hit クラス集合で SEC seed item を解決する。
// clean クラス → checked(evidence='danger-grep clean')。
// hit クラス → critical へ raise(floor=true) + checked=false 据え置き(evaluator が evidence で解消)。
// SEC 以外の item は touch しない。
export function reconcileDanger(ledger, hitClasses) {
  const hits = new Set(hitClasses);
  const items = ledger.items.map((it) => {
    if (it.source !== 'seed' || it.dimension !== 'security') return it;
    if (hits.has(it.danger_class)) {
      const severity = SEC_SEVERITY_RANK['critical'] > SEC_SEVERITY_RANK[it.severity] ? 'critical' : it.severity;
      return { ...it, severity, floor: true, checked: false };
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
export function classifyMergeTier(s) {
  const reasons = [];
  if (!s.converged) reasons.push('ledger 未収束（未 checked blocking 残）');
  if (s.unresolvedDanger) reasons.push('danger-grep hit 未解消（security 要確認）');
  if (s.breaking) reasons.push('breaking/migration 検出');
  if (s.escalateCount > 0) reasons.push(`ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`);
  if (reasons.length) return { tier: 'HOLD', reasons };
  if (s.shape === 'micro' && s.docsOrTestOnly) {
    return { tier: 'AUTO', reasons: ['micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）'] };
  }
  return { tier: 'REVIEW', reasons: ['標準 — 人間が LGTM して merge'] };
}
