// issue #409 (#390 Phase 1): trust-layer の versioned closed schema / receipt validator。
// workflow inline 対象外（Phase 1 時点で配線なし）。
//
// SurfaceProof/1・EvalSeal/1・EffectDelta/1 の 3 protocol を receipt envelope として
// closed schema に固定する pure function 群。ajv 等の新規依存は入れず hand-rolled
// whitelist 検証（既存 _lib/analyze-contract.mjs / _lib/gate-policy.mjs パターン踏襲）。
// unknown field / unknown enum / 必須欠落は closed reason code で reject する
// （throw しない — validator 自体は closed reason code で報告する）。
// node:crypto 以外の import 禁止（trust-digest.mjs は許可）。
// ファイル I/O・exec・Date.now・Math.random 禁止。

import { computeReceiptId } from './trust-digest.mjs';

// receipt envelope の schema_version closed enum。
export const TRUST_SCHEMA_VERSIONS = ['surfaceproof/1', 'evalseal/1', 'effectdelta/1'];

// outcome.verdict closed enum。
export const TRUST_VERDICTS = ['pass', 'fail', 'inconclusive'];

// trust.record_integrity closed enum（昇順: 自己申告 < 改竄検知可能 < 信頼済み環境）。
export const TRUST_RECORD_INTEGRITY = ['advisory', 'tamper-evident', 'trusted-environment'];

// validateReceipt / checkCapabilities が返す closed reason code enum。
export const TRUST_REASON_CODES = [
  'OK',
  'SCHEMA_UNKNOWN_FIELD',
  'SCHEMA_UNKNOWN_ENUM',
  'SCHEMA_MISSING_FIELD',
  'SCHEMA_TYPE_MISMATCH',
  'SCHEMA_VERSION_UNSUPPORTED',
  'RECEIPT_ID_MISMATCH',
  'DIGEST_MISMATCH',
  'CAPABILITY_MISSING',
];

// schema_version ごとに instrument.capabilities が満たすべき最小語彙（Phase 1 固定）。
// Phase 2+ で語彙拡張する場合は新 schema version を追加する（dual-path 禁止規約）。
export const REQUIRED_CAPABILITIES = {
  'surfaceproof/1': ['issue-read'],
  'evalseal/1': ['tree-read'],
  'effectdelta/1': ['effect-readback'],
};

// schema_version ごとに anchors が持てる key の whitelist。値は
// `sha256:<hex64>` digest か git OID 文字列のみ（raw 本文・secret を持たせない redaction 原則）。
export const TRUST_ANCHOR_KEYS = {
  'surfaceproof/1': ['source_revision', 'input_pack_digest'],
  'evalseal/1': ['base_oid', 'head_oid', 'tree_oid', 'bundle_digest', 'evidence_digest'],
  'effectdelta/1': ['effect_id', 'readback_digest'],
};

const TOP_LEVEL_KEYS = ['schema_version', 'receipt_id', 'subject', 'instrument', 'outcome', 'trust', 'anchors'];
const SUBJECT_KEYS = ['kind', 'identity', 'revision_digest'];
const INSTRUMENT_KEYS = ['adapter', 'adapter_version', 'config_digest', 'capabilities'];
const OUTCOME_KEYS = ['verdict', 'reason_code'];
const TRUST_KEYS = ['record_integrity'];

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason_code, detail) {
  return { ok: false, reason_code, detail };
}

// obj の own key が requiredKeys と過不足なく一致するか検査する。
// 欠落があれば SCHEMA_MISSING_FIELD、無ければ余分な key を SCHEMA_UNKNOWN_FIELD として返す。
function checkExactKeys(obj, requiredKeys, path) {
  const missing = requiredKeys.filter((k) => !Object.prototype.hasOwnProperty.call(obj, k));
  if (missing.length > 0) {
    return fail('SCHEMA_MISSING_FIELD', `${path}: 欠落フィールド ${missing.join(', ')}`);
  }
  const extra = Object.keys(obj).filter((k) => !requiredKeys.includes(k));
  if (extra.length > 0) {
    return fail('SCHEMA_UNKNOWN_FIELD', `${path}: 未知フィールド ${extra.join(', ')}`);
  }
  return null;
}

// receipt を versioned closed schema として検証する pure function。
// throw しない — 失敗は closed reason_code で報告する。
export function validateReceipt(receipt) {
  // (a) receipt が plain object か
  if (!isPlainObject(receipt)) {
    return fail('SCHEMA_TYPE_MISMATCH', 'receipt は object が必要');
  }

  // (b) schema_version が TRUST_SCHEMA_VERSIONS 内か
  if (!TRUST_SCHEMA_VERSIONS.includes(receipt.schema_version)) {
    return fail(
      'SCHEMA_VERSION_UNSUPPORTED',
      `schema_version "${String(receipt.schema_version)}" は未サポート（許可: ${TRUST_SCHEMA_VERSIONS.join(', ')}）`,
    );
  }
  const schemaVersion = receipt.schema_version;

  // (c) top-level key が正確に7個か
  const topLevelErr = checkExactKeys(receipt, TOP_LEVEL_KEYS, 'receipt');
  if (topLevelErr) return topLevelErr;

  // (d) nested object 群の欠落/余分/型を検査
  const { subject, instrument, outcome, trust, anchors } = receipt;

  if (!isPlainObject(subject)) return fail('SCHEMA_TYPE_MISMATCH', 'receipt.subject は object が必要');
  const subjectKeyErr = checkExactKeys(subject, SUBJECT_KEYS, 'receipt.subject');
  if (subjectKeyErr) return subjectKeyErr;
  for (const k of SUBJECT_KEYS) {
    if (!isNonEmptyString(subject[k])) {
      return fail('SCHEMA_TYPE_MISMATCH', `receipt.subject.${k} は非空文字列が必要`);
    }
  }

  if (!isPlainObject(instrument)) return fail('SCHEMA_TYPE_MISMATCH', 'receipt.instrument は object が必要');
  const instrumentKeyErr = checkExactKeys(instrument, INSTRUMENT_KEYS, 'receipt.instrument');
  if (instrumentKeyErr) return instrumentKeyErr;
  for (const k of ['adapter', 'adapter_version', 'config_digest']) {
    if (!isNonEmptyString(instrument[k])) {
      return fail('SCHEMA_TYPE_MISMATCH', `receipt.instrument.${k} は非空文字列が必要`);
    }
  }
  if (!Array.isArray(instrument.capabilities) || !instrument.capabilities.every((c) => isNonEmptyString(c))) {
    return fail('SCHEMA_TYPE_MISMATCH', 'receipt.instrument.capabilities は非空文字列の配列が必要');
  }

  if (!isPlainObject(outcome)) return fail('SCHEMA_TYPE_MISMATCH', 'receipt.outcome は object が必要');
  const outcomeKeyErr = checkExactKeys(outcome, OUTCOME_KEYS, 'receipt.outcome');
  if (outcomeKeyErr) return outcomeKeyErr;
  for (const k of OUTCOME_KEYS) {
    if (!isNonEmptyString(outcome[k])) {
      return fail('SCHEMA_TYPE_MISMATCH', `receipt.outcome.${k} は非空文字列が必要`);
    }
  }

  if (!isPlainObject(trust)) return fail('SCHEMA_TYPE_MISMATCH', 'receipt.trust は object が必要');
  const trustKeyErr = checkExactKeys(trust, TRUST_KEYS, 'receipt.trust');
  if (trustKeyErr) return trustKeyErr;
  for (const k of TRUST_KEYS) {
    if (!isNonEmptyString(trust[k])) {
      return fail('SCHEMA_TYPE_MISMATCH', `receipt.trust.${k} は非空文字列が必要`);
    }
  }

  // (e) enum 検証
  if (!TRUST_VERDICTS.includes(outcome.verdict)) {
    return fail('SCHEMA_UNKNOWN_ENUM', `receipt.outcome.verdict "${outcome.verdict}" は未知の値（許可: ${TRUST_VERDICTS.join(', ')}）`);
  }
  if (!TRUST_REASON_CODES.includes(outcome.reason_code)) {
    return fail(
      'SCHEMA_UNKNOWN_ENUM',
      `receipt.outcome.reason_code "${outcome.reason_code}" は未知の値（許可: ${TRUST_REASON_CODES.join(', ')}）`,
    );
  }
  if (!TRUST_RECORD_INTEGRITY.includes(trust.record_integrity)) {
    return fail(
      'SCHEMA_UNKNOWN_ENUM',
      `receipt.trust.record_integrity "${trust.record_integrity}" は未知の値（許可: ${TRUST_RECORD_INTEGRITY.join(', ')}）`,
    );
  }

  // (f) anchors の key が TRUST_ANCHOR_KEYS[schema_version] の部分集合か、値は string のみ
  if (!isPlainObject(anchors)) return fail('SCHEMA_TYPE_MISMATCH', 'receipt.anchors は object が必要');
  const allowedAnchorKeys = TRUST_ANCHOR_KEYS[schemaVersion];
  const extraAnchorKeys = Object.keys(anchors).filter((k) => !allowedAnchorKeys.includes(k));
  if (extraAnchorKeys.length > 0) {
    return fail('SCHEMA_UNKNOWN_FIELD', `receipt.anchors: 未知フィールド ${extraAnchorKeys.join(', ')}`);
  }
  for (const k of Object.keys(anchors)) {
    if (typeof anchors[k] !== 'string') {
      return fail('SCHEMA_TYPE_MISMATCH', `receipt.anchors.${k} は文字列が必要`);
    }
  }

  // (g) receipt_id の一致検証（domain-separated digest による protocol 間差し替え防止）
  if (computeReceiptId(receipt) !== receipt.receipt_id) {
    return fail('RECEIPT_ID_MISMATCH', 'receipt.receipt_id が computeReceiptId(receipt) と一致しない');
  }

  // (h) digest 形式検証（sha256:<hex64>）
  if (!DIGEST_RE.test(subject.revision_digest)) {
    return fail('DIGEST_MISMATCH', 'receipt.subject.revision_digest が sha256:<hex64> 形式でない');
  }
  if (!DIGEST_RE.test(instrument.config_digest)) {
    return fail('DIGEST_MISMATCH', 'receipt.instrument.config_digest が sha256:<hex64> 形式でない');
  }

  return { ok: true, reason_code: 'OK', detail: '' };
}

// receipt.instrument.capabilities が REQUIRED_CAPABILITIES[schema_version] を
// 全て満たすか検査する。能力不足を pass に丸めない（epic #390: inconclusive へ
// route する材料）。receipt は validateReceipt({ok:true}) 済みであることを前提とする。
export function checkCapabilities(receipt) {
  const required = REQUIRED_CAPABILITIES[receipt.schema_version] || [];
  const provided = Array.isArray(receipt?.instrument?.capabilities) ? receipt.instrument.capabilities : [];
  const missing = required.filter((c) => !provided.includes(c));
  if (missing.length > 0) {
    return { ok: false, reason_code: 'CAPABILITY_MISSING', missing };
  }
  return { ok: true, reason_code: 'OK', missing: [] };
}

// verifier 種別と tamper_evident フラグから trust level を決定する pure function。
// 'same-harness' は自己申告環境であり、tamper_evident の値に関わらず常に 'advisory'。
// 'trusted-environment' へ到達できるのは 'external-pinned' のみ（epic #390 AC-6 Phase 1
// 語彙固定。trusted verifier の実装自体は Phase 3）。out-of-enum verifier は throw する。
export function resolveTrustLevel(input) {
  const { verifier, tamper_evident } = input ?? {};
  if (verifier === 'same-harness') {
    return 'advisory';
  }
  if (verifier === 'external-pinned') {
    return tamper_evident === true ? 'trusted-environment' : 'tamper-evident';
  }
  throw new Error(`trust-schema: 未知の verifier "${verifier}"（許可: same-harness, external-pinned）`);
}
