// issue #411 (epic #390 Phase 3): trust 配線用 canonical モジュール。
//
// tools/sync-inlines.mjs の canonical 制約により import / require / Date.now / Math.random
// を一切含めない（トップレベル export const / export function のみ。export default /
// export { } 禁止）。trust-mode.mjs / trust-telemetry.mjs は import せず、layer 名・mode 値・
// summary formatter を self-containment のためローカルで重複定義する（trust-telemetry.mjs が
// Phase 1 で宣言した precedent に従う）。両定数の一致は本ファイル隣接の
// _lib/trust-wiring.test.mjs（cross-import して比較する側）で担保する。
//
// TRUST_LAYER_CONFIG は repo 定数。QUALITY_MODEL（_lib/quality-model.mjs）と同じ
// 「_lib 1 行変更 + tools/sync-inlines.mjs --write で切替」パターン。
// surfaceproof: 'shadow'（issue #410, epic #390 Phase 2 — dev-flow.js の Analyze phase へ配線済み）。
// evalseal: 'shadow'（issue #411, epic #390 Phase 3 — dev-flow.js の Evaluate/Final reconcile へ配線済み。
// issue #471, epic #390 Phase 6 で evalseal/2（機械導出 verdict）へ移行済み）。
// effectdelta: 'shadow'（issue #412, epic #390 Phase 4 — dev-flow.js の PR phase（pr-observe）・
// post-summary（comment-prepare/comment-observe + subagent の bare gh choreography。issue #466）へ配線済み）。
// sunset: epic #390 Phase 5 の 2x2x2 dogfood 後に advisory/blocking へ昇格を検討する。
export const TRUST_LAYER_CONFIG = { surfaceproof: 'shadow', evalseal: 'shadow', effectdelta: 'shadow' };

// 全 layer 強制 off の workflow 側 kill switch。script 側は env TRUST_KILL_SWITCH で
// 独立に持つ（二重防御。git remote から独立に repoSlug を再解決する fail-closed と同型）。
export const TRUST_KILL_SWITCH = false;

// EvalSeal (evalseal/2) obligation の asserted 区画（evaluator 収束スナップショット等の agent
// 判断）を構築する pure function。issue #471 で verdict/reasonCode 引数を撤去し asserted-only
// 化した — outcome.verdict は evalseal-seal.mjs が evidence bundle から機械導出するため、
// obligation は digest のみに寄与する asserted 区画（{evidence, context}）に閉じる（AC-2）。
// evidence は文字列配列必須（非配列・非文字列要素は throw）。
// context は plain object のみ許可（配列・null・非 object は throw）、未指定は空 object。
export function buildEvalsealObligation({ evidence, context } = {}) {
  if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'string')) {
    throw new Error('trust-wiring: evidence は文字列配列が必要');
  }

  const safeContext = context === undefined ? {} : context;
  if (safeContext === null || typeof safeContext !== 'object' || Array.isArray(safeContext)) {
    throw new Error('trust-wiring: context は plain object が必要');
  }

  return { asserted: { evidence, context: safeContext } };
}

// EvalSeal (evalseal/2) evidence bundle を構築する pure function（issue #471）。
// diff-risk-classify.sh の risk 判定 raw object と test green 判定を素通しで包むだけ
// （検証・導出は evalseal-seal.mjs 側の責務のため throw しない）。risk 未指定は null、
// testGreen が boolean でなければ null（no_tests・未実行等を機械導出不能として扱わせる）。
export function buildEvalsealEvidenceBundle({ risk, testGreen } = {}) {
  return {
    risk: risk ?? null,
    test: { green: typeof testGreen === 'boolean' ? testGreen : null },
  };
}

// EvalSeal receipt 欠落理由の closed enum（issue #471 AC-6）。out-of-enum は telemetry 出力側
// （dev-flow.js）で 'unknown' に正規化する。
export const TRUST_EVALSEAL_MISSING_REASONS = ['eval_skipped', 'agent_throw', 'agent_null', 'seal_error', 'mode_off', 'unknown'];

// [{ envelope: {verdict,...}, invalidated: boolean, stage: 'evaluate'|'final' }] から、
// invalidated でない最新（配列末尾優先）entry の envelope.verdict を返す。
// 全滅/空配列/非配列は 'inconclusive' を返す（受領物なし = 成功扱いしない）。
export function effectiveTrustVerdict(receiptEntries) {
  if (!Array.isArray(receiptEntries)) return 'inconclusive';
  for (let i = receiptEntries.length - 1; i >= 0; i -= 1) {
    const entry = receiptEntries[i];
    if (entry && entry.invalidated !== true) {
      return entry.envelope?.verdict ?? 'inconclusive';
    }
  }
  return 'inconclusive';
}

// verdict → PR summary 上の STATUS 表記への写像（_lib/trust-telemetry.mjs の
// formatTrustSummary と同一写像をローカルで重複定義）。
const VERDICT_STATUS = {
  pass: 'VERIFIED',
  fail: 'HOLD',
  inconclusive: 'INCONCLUSIVE',
};

// _lib/trust-telemetry.mjs の formatTrustSummary の import-free 複製 + invalidated 拡張。
// 空配列、または全 envelope が mode==='off' の場合は空文字を返す（既存 summary を
// byte 互換に保つ UX 決定を踏襲）。invalidated===true の entry には行末に
// ` [invalidated]` を付ける（旧 receipt 失効の可視化）。invalidated フィールドを
// 含まない入力では formatTrustSummary と文字列完全一致する（cross-check test で担保）。
export function formatTrustReceiptsSummary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const active = entries.filter((env) => env.mode !== 'off');
  if (active.length === 0) {
    return '';
  }

  const lines = ['### Trust receipts (shadow)', ''];
  const detailLines = ['<details><summary>digests</summary>', ''];

  for (const env of active) {
    const status = VERDICT_STATUS[env.verdict];
    const suffix = env.invalidated === true ? ' [invalidated]' : '';
    lines.push(`- ${env.layer} [${env.mode}]: ${status} (${env.reason_code}) subject=${env.subject_kind}:${env.subject_identity}${suffix}`);
    detailLines.push(`- ${env.layer}: receipt_id=${env.receipt_id} revision_digest=${env.revision_digest}`);
  }

  detailLines.push('', '</details>');

  return [...lines, '', ...detailLines].join('\n');
}
