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
// 配線先（mode に関わらず存置）: surfaceproof = dev-flow.js の Analyze phase、
// evalseal = Evaluate / Final reconcile、effectdelta = PR phase（pr-observe）・post-summary
// （comment-prepare/comment-observe）。'off' では各 call site が丸ごと skip され追加 agent 呼出しは 0 件。
//
// 全 layer 'off'。shadow は「既存 gate を変えない（AC-11/AC-15）」を保証するが、
// **run を壊さないことは保証しない** — shadow 固定のまま run abort と telemetry 全損が実測された:
//   - trust-*.json の stale 上書きが safety classifier に [Logging/Audit Tampering] と判定され
//     Setup が null を返して run abort（2026-08-17, issue #503, wf_3f47928a-ba2）。
//   - trust-seal-eval のブロックが同 run の journal-log まで連鎖ブロックし、
//     完走した run の telemetry が journal に 1 件も残らなかった（2026-08-04, issue #485）。
// trust layer の call site は監査証跡の上書き・自己封緘・receipt 自己発行を行うため、
// 挙動が改ざん者と同型になり classifier と構造的に衝突する。gate 非改変では相殺できない
// run 単位のコストなので、観測を続ける前提が成立するまで実行しない。
//
// 再開条件（この 3 つが揃うまで 'shadow' へ戻さない。1 つでも欠けたら off のまま）:
//   1. call site が監査改ざんと同型でない形に再設計されている（証跡の破壊的上書きをしない）。
//   2. trust 由来の classifier ブロックが run abort / telemetry 欠落へ波及しない
//      （journal-log への連鎖遮断が実測で確認できている）。
//   3. off 期間の完走率を分母として、shadow 復帰後の完走率が有意に劣後しないと確認できる。
// 撤去（コード削除）判断は off 期間の実測後に別 issue で行う。
export const TRUST_LAYER_CONFIG = { surfaceproof: 'off', evalseal: 'off', effectdelta: 'off' };

// 全 layer 強制 off の workflow 側 kill switch。script 側は env TRUST_KILL_SWITCH で
// 独立に持つ（二重防御。git remote から独立に repoSlug を再解決する fail-closed と同型）。
export const TRUST_KILL_SWITCH = false;

// EvalSeal receipt 欠落理由の closed enum（issue #471 AC-6）。out-of-enum は telemetry 出力側
// （dev-flow.js）で 'unknown' に正規化する。
export const TRUST_EVALSEAL_MISSING_REASONS = ['eval_skipped', 'agent_throw', 'agent_null', 'seal_error', 'mode_off', 'unknown'];

// EffectDelta PR stage receipt 欠落理由の closed enum（issue #476 D-3）。EvalSeal と共通化せず
// 独立定義する — 送り側（dev-flow.js の trust-effectdelta-pr probe）の実分岐が catch（throw）と
// mode==='off' に加え、agent fallback 形 {ok:false,error} の error 文字列由来の 3 分類
// （gh_failed/script_error/agent_error）と成功条件未達（schema_invalid）を持つため。
// out-of-enum は telemetry 出力側（dev-flow.js）で 'unknown' に正規化する。
export const TRUST_EFFECTDELTA_PR_MISSING_REASONS = [
  'agent_throw',
  'agent_null',
  'mode_off',
  'gh_failed',
  'script_error',
  'agent_error',
  'schema_invalid',
  'unknown',
];

// gh/GitHub API 由来の失敗を示す決定論 regex（上流原因を優先するため script 系より先に判定する）。
const EFFECTDELTA_GH_FAILURE_RE = /(^|[^a-z])gh([^a-z]|$)|github|http[ _-]?[45][0-9][0-9]|rate ?limit|auth/i;

// pr-observe / effectdelta-github.sh 等の決定論スクリプト実行系失敗を示す regex。
const EFFECTDELTA_SCRIPT_FAILURE_RE = /pr-observe|effectdelta-github|exit +[1-9]|stdout|json/i;

// trust-effectdelta-pr probe の非 throw 欠落ケースを分類する pure function（issue #476）。
// 呼び出し側（dev-flow.js）が try/catch で throw を 'agent_throw' に振り分けた残余（非 throw の
// res）だけを受け取る前提。判定順は上流原因優先: (a) res が null/undefined → 'agent_null'、
// (b) res.mode === 'off' → 'mode_off'、(c) res.ok === false かつ error が文字列のとき gh 系 regex
// 優先で gh_failed → script 系 regex で script_error → 非マッチ/非文字列は agent_error、
// (d) res.ok === true（receipt/envelope 欠落等で成功条件を満たさなかった場合にのみ到達）→
// 'schema_invalid'、(e) それ以外の未知形状 → 'unknown'。
export function classifyEffectdeltaPrMissing(res) {
  if (res === null || res === undefined) {
    return 'agent_null';
  }
  if (res.mode === 'off') {
    return 'mode_off';
  }
  if (res.ok === false) {
    if (typeof res.error === 'string') {
      if (EFFECTDELTA_GH_FAILURE_RE.test(res.error)) {
        return 'gh_failed';
      }
      if (EFFECTDELTA_SCRIPT_FAILURE_RE.test(res.error)) {
        return 'script_error';
      }
    }
    return 'agent_error';
  }
  if (res.ok === true) {
    return 'schema_invalid';
  }
  return 'unknown';
}

// log 専用の redacted hint を返す pure function（issue #476 AC-3）。raw error は telemetry /
// receipt / PR summary のどこにも保存せず、workflow log 行にのみこの出力を使う想定。
// 非文字列は ''、文字列は先頭行のみ抽出し、URL を '<url>'、16 文字以上の token 様文字列を
// '<token>' に置換した上で 120 文字に truncate する。
export function redactEffectdeltaError(error) {
  if (typeof error !== 'string') {
    return '';
  }
  const firstLine = error.split('\n')[0];
  const redacted = firstLine
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[A-Za-z0-9_-]{16,}/g, '<token>');
  return redacted.slice(0, 120);
}

// EffectDelta PR stage receipt 欠落理由を PR summary へ追記するブロックを構築する pure
// function（issue #476）。呼び出し側（dev-flow.js）が EFFECTDELTA_MODE!=='off' 判定・
// out-of-enum の 'unknown' 正規化を行った上で reason を渡す前提。reason が非文字列・空文字の
// 場合は追記しない意図で '' を返す。
export function formatEffectdeltaPrMissingSummary(reason) {
  if (typeof reason !== 'string' || reason === '') {
    return '';
  }
  return `### Trust receipts (shadow) — missing\n\n- effectdelta [shadow]: INCONCLUSIVE (missing_reason=${reason}) stage=pr`;
}

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
