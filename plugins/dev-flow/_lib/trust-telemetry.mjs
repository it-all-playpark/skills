// issue #409 (#390 Phase 1): trust-layer 共通 run_id・telemetry envelope・summary formatter。
// workflow inline 対象外（Phase 1 時点で配線なし）。
//
// journal telemetry へ渡す最小 envelope（digest / ID / closed enum のみ）と、
// PR summary 追記用の Markdown formatter を提供する pure function 群。
// epic #390 の redaction 原則: private 本文・secret・raw credential・anchors 値は
// telemetry へ保存しない。
//
// trust-mode.mjs / trust-digest.mjs は import しない（並列 task との結合を作らない
// ための self-containment。layer 名・mode 値はローカル定数として重複定義する。両定数の
// 一致は将来 Phase 2 の配線 test で担保する）。
//
// node:crypto 以外の import も含め一切禁止。ファイル I/O・exec・Date.now・Math.random 禁止。

import { TRUST_SCHEMA_VERSIONS, TRUST_VERDICTS, TRUST_RECORD_INTEGRITY, TRUST_REASON_CODES } from './trust-schema.mjs';

// telemetry layer の closed enum（trust-mode.mjs の TRUST_LAYERS とローカルで重複定義）。
export const TELEMETRY_LAYERS = ['surfaceproof', 'evalseal', 'effectdelta'];

// telemetry mode の closed enum（trust-mode.mjs の TRUST_MODES とローカルで重複定義）。
export const TELEMETRY_MODES = ['off', 'shadow', 'advisory', 'blocking'];

const RUN_ID_ENTROPY_RE = /^[0-9a-f]{12}$/;
const RUN_ID_RE = /^trust-([0-9]+)-([0-9a-f]{12})$/;

// verdict → PR summary 上の STATUS 表記への写像（色・絵文字に依存せず本文テキストで示す）。
const VERDICT_STATUS = {
  pass: 'VERIFIED',
  fail: 'HOLD',
  inconclusive: 'INCONCLUSIVE',
};

// {timestampMs, entropyHex} から決定論的に trust run_id を生成する pure function。
// Date.now / Math.random は使わない — 呼び出し側が値を注入する。
export function makeTrustRunId({ timestampMs, entropyHex } = {}) {
  if (!Number.isInteger(timestampMs) || timestampMs <= 0) {
    throw new Error(`trust-telemetry: timestampMs は正の整数が必要 (got: ${JSON.stringify(timestampMs)})`);
  }
  if (typeof entropyHex !== 'string' || !RUN_ID_ENTROPY_RE.test(entropyHex)) {
    throw new Error(`trust-telemetry: entropyHex は /^[0-9a-f]{12}$/ に一致する文字列が必要 (got: ${JSON.stringify(entropyHex)})`);
  }
  return `trust-${timestampMs}-${entropyHex}`;
}

function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

// {run_id, layer, mode, receipt} から journal telemetry 用の最小 envelope を返す。
// receipt の raw 本文・anchors 値以外の生データは含めない（digest / ID / enum のみ）。
export function buildTrustEnvelope({ run_id, layer, mode, receipt } = {}) {
  if (!isValidRunId(run_id)) {
    throw new Error(`trust-telemetry: run_id が makeTrustRunId 形式でない (got: ${JSON.stringify(run_id)})`);
  }
  if (!TELEMETRY_LAYERS.includes(layer)) {
    throw new Error(`trust-telemetry: layer "${layer}" は未知の値（許可: ${TELEMETRY_LAYERS.join(', ')}）`);
  }
  if (!TELEMETRY_MODES.includes(mode)) {
    throw new Error(`trust-telemetry: mode "${mode}" は未知の値（許可: ${TELEMETRY_MODES.join(', ')}）`);
  }
  if (receipt === null || typeof receipt !== 'object') {
    throw new Error('trust-telemetry: receipt は object が必要');
  }

  const schemaVersion = receipt.schema_version;
  if (!TRUST_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new Error(`trust-telemetry: receipt.schema_version "${schemaVersion}" は未知の値（許可: ${TRUST_SCHEMA_VERSIONS.join(', ')}）`);
  }

  const receiptId = receipt.receipt_id;
  if (typeof receiptId !== 'string' || receiptId === '') {
    throw new Error('trust-telemetry: receipt.receipt_id は非空文字列が必要');
  }

  const verdict = receipt?.outcome?.verdict;
  if (!TRUST_VERDICTS.includes(verdict)) {
    throw new Error(`trust-telemetry: receipt.outcome.verdict "${verdict}" は未知の値（許可: ${TRUST_VERDICTS.join(', ')}）`);
  }

  const reasonCode = receipt?.outcome?.reason_code;
  if (!TRUST_REASON_CODES.includes(reasonCode)) {
    throw new Error(`trust-telemetry: receipt.outcome.reason_code "${reasonCode}" は未知の値（許可: ${TRUST_REASON_CODES.join(', ')}）`);
  }

  const recordIntegrity = receipt?.trust?.record_integrity;
  if (!TRUST_RECORD_INTEGRITY.includes(recordIntegrity)) {
    throw new Error(`trust-telemetry: receipt.trust.record_integrity "${recordIntegrity}" は未知の値（許可: ${TRUST_RECORD_INTEGRITY.join(', ')}）`);
  }

  const subjectKind = receipt?.subject?.kind;
  const subjectIdentity = receipt?.subject?.identity;
  const revisionDigest = receipt?.subject?.revision_digest;
  if (typeof subjectKind !== 'string' || subjectKind === '') {
    throw new Error('trust-telemetry: receipt.subject.kind は非空文字列が必要');
  }
  if (typeof subjectIdentity !== 'string' || subjectIdentity === '') {
    throw new Error('trust-telemetry: receipt.subject.identity は非空文字列が必要');
  }
  if (typeof revisionDigest !== 'string' || revisionDigest === '') {
    throw new Error('trust-telemetry: receipt.subject.revision_digest は非空文字列が必要');
  }

  return {
    run_id,
    layer,
    mode,
    schema_version: schemaVersion,
    receipt_id: receiptId,
    verdict,
    reason_code: reasonCode,
    record_integrity: recordIntegrity,
    subject_kind: subjectKind,
    subject_identity: subjectIdentity,
    revision_digest: revisionDigest,
  };
}

// PR summary 追記用の Markdown 文字列を返す。空配列、または全 envelope が mode==='off'
// の場合は空文字を返す（epic #390 UX 決定: layer off 時は既存 summary を byte 互換に保つ）。
export function formatTrustSummary(envelopes) {
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    return '';
  }
  const active = envelopes.filter((env) => env.mode !== 'off');
  if (active.length === 0) {
    return '';
  }

  const lines = ['### Trust receipts (shadow)', ''];
  const detailLines = ['<details><summary>digests</summary>', ''];

  for (const env of active) {
    const status = VERDICT_STATUS[env.verdict];
    lines.push(`- ${env.layer} [${env.mode}]: ${status} (${env.reason_code}) subject=${env.subject_kind}:${env.subject_identity}`);
    detailLines.push(`- ${env.layer}: receipt_id=${env.receipt_id} revision_digest=${env.revision_digest}`);
  }

  detailLines.push('', '</details>');

  return [...lines, '', ...detailLines].join('\n');
}
