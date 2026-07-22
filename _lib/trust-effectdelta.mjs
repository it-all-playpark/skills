// issue #412 (#390 Phase 4): EffectDelta adapter — write-once GitHub effect (PR / comment)
// 用の pure core。workflow inline 対象外（_lib/trust-surfaceproof.mjs と同じ位置づけ —
// F4 で dev-flow.js からは effectdelta-github.sh / CLI 経由でのみ利用する）。
//
// Phase 1 kernel（trust-digest.mjs / trust-schema.mjs）は一切変更しない。本ファイルは
// kernel と同一の I/O 規約に従う pure function 群 — import は `./trust-digest.mjs` の
// domainSeparatedDigest / sha256Hex / computeReceiptId、`./trust-schema.mjs` の
// validateReceipt / resolveTrustLevel のみ（node:crypto 直接 import 禁止・trust-digest
// 経由のみ）。ファイル I/O・exec・Date.now・Math.random 禁止。
//
// blind retry を行わない（provider timeout・成功応答消失時も read-only rediscovery で
// observed|mismatch|inconclusive の closed taxonomy に落とす — AC-8/AC-9/edge case
// response-lost）。write-once の実際の gh 呼び出しは F2（effectdelta-github.sh）が担う。

import { domainSeparatedDigest, sha256Hex, computeReceiptId } from './trust-digest.mjs';
import { resolveTrustLevel } from './trust-schema.mjs';

// ---- (1) 定数 ----

// PR/comment 効果の観測結果 closed taxonomy（epic #390 Phase 4）。
export const EFFECTDELTA_OBSERVATIONS = ['observed', 'mismatch', 'inconclusive'];

// classifyPrObservation / classifyCommentObservation が返す domain reason code の
// closed enum。TRUST_REASON_CODES（trust-schema.mjs）とは別語彙 — receipt には入れず
// workflow state 側の telemetry mapping にのみ passthrough する（plan の設計判断）。
export const EFFECTDELTA_REASON_CODES = [
  'OK',
  'DUPLICATE_EFFECT',
  'WRONG_TARGET',
  'RESPONSE_LOST',
  'TARGET_MISSING',
  'PROBE_FAILED',
];

const BODY_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// repo/issue/pr/run_id 等の identity field は string か finite number のみ許可する
// （GitHub API は issue/PR number を number で返すため）。
function isIdentityScalar(v) {
  return isNonEmptyString(v) || (typeof v === 'number' && Number.isFinite(v));
}

// ---- (2) derivePrEffectId ----

// PR write 効果の identity digest。domain-separated（'effectdelta/pr/1'）— 同一
// payload でも他 domain（comment/journal 等）とは digest が必ず異なる（epic #390 AC-2 系）。
export function derivePrEffectId({ repo, issue, base, head_oid } = {}) {
  if (!isNonEmptyString(repo)) {
    throw new Error('trust-effectdelta: derivePrEffectId の repo は非空文字列が必要');
  }
  if (!isIdentityScalar(issue)) {
    throw new Error('trust-effectdelta: derivePrEffectId の issue は非空文字列か有限数値が必要');
  }
  if (!isNonEmptyString(base)) {
    throw new Error('trust-effectdelta: derivePrEffectId の base は非空文字列が必要');
  }
  if (!isNonEmptyString(head_oid)) {
    throw new Error('trust-effectdelta: derivePrEffectId の head_oid は非空文字列が必要');
  }
  return domainSeparatedDigest('effectdelta/pr/1', { repo, issue, base, head_oid });
}

// ---- (3) deriveCommentEffectId ----

// comment write 効果の identity digest。domain-separated（'effectdelta/comment/1'）。
// body_digest は `sha256:<hex64>` 形式必須（raw 本文は receipt/marker に持たせない
// redaction 原則）。
export function deriveCommentEffectId({ repo, pr, effect_type, run_id, body_digest } = {}) {
  if (!isNonEmptyString(repo)) {
    throw new Error('trust-effectdelta: deriveCommentEffectId の repo は非空文字列が必要');
  }
  if (!isIdentityScalar(pr)) {
    throw new Error('trust-effectdelta: deriveCommentEffectId の pr は非空文字列か有限数値が必要');
  }
  if (!isNonEmptyString(effect_type)) {
    throw new Error('trust-effectdelta: deriveCommentEffectId の effect_type は非空文字列が必要');
  }
  if (!isIdentityScalar(run_id)) {
    throw new Error('trust-effectdelta: deriveCommentEffectId の run_id は非空文字列か有限数値が必要');
  }
  if (!isNonEmptyString(body_digest) || !BODY_DIGEST_RE.test(body_digest)) {
    throw new Error('trust-effectdelta: deriveCommentEffectId の body_digest は sha256:<hex64> 形式が必要');
  }
  return domainSeparatedDigest('effectdelta/comment/1', { repo, pr, effect_type, run_id, body_digest });
}

// ---- (4) commentMarker ----

// PR comment 本文に埋め込む write-once marker。effectId は sha256 全長 hex を含むため
// 偶然一致は実質不可能（edge case: ユーザー由来本文への誤検出耐性）。
export function commentMarker(effectId) {
  if (!isNonEmptyString(effectId)) {
    throw new Error('trust-effectdelta: commentMarker の effectId は非空文字列が必要');
  }
  return `<!-- devflow-effect: ${effectId} -->`;
}

// ---- (5) classifyPrObservation ----

function prMatchesIntended(pr, intended) {
  return (
    isPlainObject(pr) &&
    pr.state === 'OPEN' &&
    pr.baseRefName === intended.base &&
    pr.headRefOid === intended.head_oid
  );
}

// PR write 効果の read-only rediscovery 結果を closed taxonomy に分類する。
//
// - `candidates`: 同一 head branch の open PR 配列。**listing 自体が失敗/未実行なら
//   `null`**（probe failure signal）。listing が成功し該当ゼロ件なら `[]`（作成前探索の
//   正常系 — 作成前は空で当然のため target-missing と区別する）。
// - `readback`: 意図した対象 PR の readback。取得できない/未実行なら `null`。
// - `responseLost`: write 呼び出し自体が timeout 等で応答消失したか。
//
// 判定は仕様の (a)〜(f) を優先順位付きラダーで適用する。
export function classifyPrObservation({ intended, candidates, readback, responseLost = false } = {}) {
  if (!isPlainObject(intended) || !isNonEmptyString(intended.base) || !isNonEmptyString(intended.head_oid)) {
    throw new Error('trust-effectdelta: classifyPrObservation の intended.{base,head_oid} が必要');
  }
  if (candidates !== null && !Array.isArray(candidates)) {
    throw new Error('trust-effectdelta: classifyPrObservation の candidates は配列か null が必要');
  }
  if (readback !== null && !isPlainObject(readback)) {
    throw new Error('trust-effectdelta: classifyPrObservation の readback は object か null が必要');
  }
  if (typeof responseLost !== 'boolean') {
    throw new Error('trust-effectdelta: classifyPrObservation の responseLost は boolean が必要');
  }

  const matchCount = Array.isArray(candidates) ? candidates.filter((c) => prMatchesIntended(c, intended)).length : 0;

  // (a) readback が意図どおり(base/head/state)一致し、candidates 中の該当 open PR がちょうど1件
  if (prMatchesIntended(readback, intended) && matchCount === 1) {
    return { status: 'observed', reason_code: 'OK' };
  }

  // (b) 該当 open PR が2件以上（重複）
  if (matchCount >= 2) {
    return { status: 'mismatch', reason_code: 'DUPLICATE_EFFECT' };
  }

  // (c) readback はあるが base/head/state のいずれか不一致
  if (readback !== null) {
    return { status: 'mismatch', reason_code: 'WRONG_TARGET' };
  }

  // (d) 応答消失かつ rediscovery（candidates）が空/未実行
  if (responseLost === true && (candidates === null || candidates.length === 0)) {
    return { status: 'inconclusive', reason_code: 'RESPONSE_LOST' };
  }

  // (e) listing 自体が失敗/未実行（probe 自体の失敗）
  if (candidates === null) {
    return { status: 'inconclusive', reason_code: 'PROBE_FAILED' };
  }

  // (f) listing は成功したが該当ゼロ件 かつ readback も無い（作成前探索文脈）
  return { status: 'inconclusive', reason_code: 'TARGET_MISSING' };
}

// ---- (6) classifyCommentObservation ----

function commentFieldsMatch(a, b) {
  return isPlainObject(a) && isPlainObject(b) && a.body_digest === b.body_digest && a.author === b.author && a.pr === b.pr;
}

// comment write 効果の read-only rediscovery 結果を closed taxonomy に分類する。
//
// - `matches`: marker 完全一致で見つかった comment 配列（`{id, body_digest, author, pr}`）。
//   marker 検索自体が失敗/未実行なら `null`、成功しゼロ件なら `[]`。
// - `readback`: 今回投稿した（または対象とする）comment の readback。取得できなければ `null`。
// - `preexisting`: 今回は投稿せず既存 comment を発見した（重複抑止の正常系）場合に `true`。
export function classifyCommentObservation({
  effect_id,
  expected_body_digest,
  matches,
  readback,
  responseLost = false,
  preexisting = false,
} = {}) {
  if (!isNonEmptyString(effect_id)) {
    throw new Error('trust-effectdelta: classifyCommentObservation の effect_id は非空文字列が必要');
  }
  if (!isNonEmptyString(expected_body_digest) || !BODY_DIGEST_RE.test(expected_body_digest)) {
    throw new Error('trust-effectdelta: classifyCommentObservation の expected_body_digest は sha256:<hex64> 形式が必要');
  }
  if (matches !== null && !Array.isArray(matches)) {
    throw new Error('trust-effectdelta: classifyCommentObservation の matches は配列か null が必要');
  }
  if (readback !== null && !isPlainObject(readback)) {
    throw new Error('trust-effectdelta: classifyCommentObservation の readback は object か null が必要');
  }
  if (typeof responseLost !== 'boolean') {
    throw new Error('trust-effectdelta: classifyCommentObservation の responseLost は boolean が必要');
  }
  if (typeof preexisting !== 'boolean') {
    throw new Error('trust-effectdelta: classifyCommentObservation の preexisting は boolean が必要');
  }

  const matchCount = Array.isArray(matches) ? matches.length : 0;

  // 2件以上 → 重複（異常系）
  if (matchCount >= 2) {
    return { status: 'mismatch', reason_code: 'DUPLICATE_EFFECT' };
  }

  if (matchCount === 1) {
    const matched = matches[0];

    // 今回は投稿せず既存 comment を発見（重複抑止の正常系）
    if (preexisting === true) {
      return { status: 'observed', reason_code: 'DUPLICATE_EFFECT' };
    }

    // 新規投稿後の readback が期待 digest・marker 一致 comment と整合する
    if (isPlainObject(readback) && readback.body_digest === expected_body_digest && commentFieldsMatch(readback, matched)) {
      return { status: 'observed', reason_code: 'OK' };
    }

    // readback は取得できたが digest/author/pr のいずれかが不一致
    if (readback !== null) {
      return { status: 'mismatch', reason_code: 'WRONG_TARGET' };
    }

    // matched はあるが readback が未取得/失敗 — 検証不能（probe 自体の失敗）
    return { status: 'inconclusive', reason_code: 'PROBE_FAILED' };
  }

  // ここから matchCount === 0

  // 応答消失かつ rediscovery（marker 検索）も空/未実行
  if (responseLost === true && (matches === null || matches.length === 0)) {
    return { status: 'inconclusive', reason_code: 'RESPONSE_LOST' };
  }

  // marker 検索自体が失敗/未実行（probe 自体の失敗）
  return { status: 'inconclusive', reason_code: 'PROBE_FAILED' };
}

// ---- (7) observationToOutcome ----

// EffectDelta domain observation を TRUST_REASON_CODES（trust-schema.mjs）へ縮約する。
// domain reason code（DUPLICATE_EFFECT 等）の保存は workflow 側 entry の責務 — receipt
// には入れない（schema_version bump 回避。plan の設計判断）。
export function observationToOutcome(status) {
  if (status === 'observed') return { verdict: 'pass', reason_code: 'OK' };
  if (status === 'mismatch') return { verdict: 'fail', reason_code: 'DIGEST_MISMATCH' };
  if (status === 'inconclusive') return { verdict: 'inconclusive', reason_code: 'CAPABILITY_MISSING' };
  throw new Error(`trust-effectdelta: 未知の observation status "${status}"（許可: ${EFFECTDELTA_OBSERVATIONS.join(', ')}）`);
}

// ---- (8) buildEffectDeltaReceipt ----

// readback digest が無い場合（inconclusive）に anchors から欠落させないための固定値。
const NO_READBACK_DIGEST = sha256Hex('effectdelta/no-readback');

// EffectDelta/1 receipt を組み立てる。trust.record_integrity は resolveTrustLevel
// ('same-harness') 経由で 'advisory'（自己申告環境 — kernel と同一語彙）。
// 戻り値は必ず validateReceipt で {ok:true} になる（test で担保）。
export function buildEffectDeltaReceipt({ effect_id, readback_digest, subject_identity, status, config } = {}) {
  if (!isNonEmptyString(effect_id)) {
    throw new Error('trust-effectdelta: buildEffectDeltaReceipt の effect_id は非空文字列が必要');
  }
  if (!isNonEmptyString(subject_identity)) {
    throw new Error('trust-effectdelta: buildEffectDeltaReceipt の subject_identity は非空文字列が必要');
  }
  if (!EFFECTDELTA_OBSERVATIONS.includes(status)) {
    throw new Error(`trust-effectdelta: buildEffectDeltaReceipt の status "${status}" は未知（許可: ${EFFECTDELTA_OBSERVATIONS.join(', ')}）`);
  }

  const resolvedReadbackDigest = isNonEmptyString(readback_digest) ? readback_digest : NO_READBACK_DIGEST;
  const outcome = observationToOutcome(status);
  const configDigest = domainSeparatedDigest('effectdelta/config/1', config ?? {});

  const receiptWithoutId = {
    schema_version: 'effectdelta/1',
    subject: {
      kind: 'effect',
      identity: subject_identity,
      revision_digest: resolvedReadbackDigest,
    },
    instrument: {
      adapter: 'effectdelta-github',
      adapter_version: '1',
      config_digest: configDigest,
      capabilities: ['effect-readback'],
    },
    outcome,
    trust: {
      record_integrity: resolveTrustLevel({ verifier: 'same-harness' }),
    },
    anchors: {
      effect_id,
      readback_digest: resolvedReadbackDigest,
    },
  };

  return { ...receiptWithoutId, receipt_id: computeReceiptId(receiptWithoutId) };
}
