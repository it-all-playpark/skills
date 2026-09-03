// issue #409 (#390 Phase 1): trust-layer canonical bytes / domain-separated digest。
// workflow inline 対象外（Phase 1 時点で配線なし）。
//
// canonical JSON bytes + domain-separated sha256 digest の pure function 群。
// trust-layer kernel（SurfaceProof / EvalSeal / EffectDelta receipt）の基盤。
// node:crypto 以外の import 禁止。ファイル I/O・exec・Date.now・Math.random 禁止。

import { createHash } from 'node:crypto';

// value を決定論的に canonicalize した JSON 文字列（UTF-8 相当）を返す。
// object key は再帰的に UTF-16 code unit 昇順で sort し、空白を含まない最小形にする。
// 配列は順序を保持する。undefined / NaN / Infinity / function / symbol / bigint /
// 循環参照は throw する（JSON.stringify の暗黙 null 化・key 欠落を許さない）。
export function canonicalJsonBytes(value) {
  const ancestors = new Set();

  function serialize(v) {
    if (v === undefined) {
      throw new Error('trust-digest: canonical化できない値 (undefined)');
    }
    if (v === null) return 'null';

    const t = typeof v;

    if (t === 'boolean') return v ? 'true' : 'false';

    if (t === 'number') {
      if (Number.isNaN(v) || !Number.isFinite(v)) {
        throw new Error(`trust-digest: canonical化できない値 (number: ${String(v)})`);
      }
      return JSON.stringify(v);
    }

    if (t === 'string') return JSON.stringify(v);

    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      throw new Error(`trust-digest: canonical化できない値 (typeof ${t})`);
    }

    if (t !== 'object') {
      throw new Error(`trust-digest: canonical化できない値 (typeof ${t})`);
    }

    if (ancestors.has(v)) {
      throw new Error('trust-digest: canonical化できない値 (循環参照)');
    }
    ancestors.add(v);

    let out;
    if (Array.isArray(v)) {
      out = `[${v.map((el) => serialize(el)).join(',')}]`;
    } else {
      const keys = Object.keys(v).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(v[k])}`).join(',')}}`;
    }

    ancestors.delete(v);
    return out;
  }

  return serialize(value);
}

// text の sha256 hex digest を `sha256:<hex64>` 形式で返す。
export function sha256Hex(text) {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

// domain（receipt の schema_version 等）で分離した digest を返す。
// protocol 間の receipt 差し替え防止（epic #390 AC-2）の要 —
// 同一 payload でも domain が異なれば digest は必ず異なる。
export function domainSeparatedDigest(domain, value) {
  if (typeof domain !== 'string' || domain === '') {
    throw new Error(`trust-digest: domain は非空文字列が必要 (got: ${JSON.stringify(domain)})`);
  }
  const bytes = canonicalJsonBytes(value);
  return sha256Hex(`${domain}\n${bytes}`);
}

// receipt object から receipt_id field を除いた copy を作り、
// domainSeparatedDigest(receipt.schema_version, copyWithoutReceiptId) を返す。
export function computeReceiptId(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('trust-digest: receipt は object が必要');
  }
  if (typeof receipt.schema_version !== 'string' || receipt.schema_version === '') {
    throw new Error('trust-digest: receipt.schema_version が必要');
  }
  const { receipt_id, ...rest } = receipt;
  return domainSeparatedDigest(receipt.schema_version, rest);
}
