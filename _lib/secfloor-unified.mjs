// parseSecfloorFields: dev-flow Security floor が使う統合 exec-proxy
// (`_shared/scripts/secfloor-classify.sh`) の応答を per-field 独立に検証する純関数 (issue #544, S1)。
//
// 統合スクリプトは {"risk":..., "files":..., "struct":..., "diffhash":...} の 1 JSON object を返すが、
// 各フィールドはそれぞれ別のフィールド別失敗ポリシーを持つ (下記)。本関数は「1 フィールドの不正が
// 他フィールドの判定に影響しない」ことを保証するため、各フィールドを完全に独立して検証する。
//
// フィールド別失敗ポリシー:
//   risk   - fail-closed。unified?.risk が object かつ typeof ok==='boolean' かつ
//            Array.isArray(hits) のときのみそのまま採用。それ以外は
//            {ok:false, hits:[], error:'secfloor unified proxy unavailable (fail-closed)'} を合成
//            (null は返さない -- hits フィールド欠落を clean と同一視しない fail-closed が要件。
//            security floor の reconcileDanger/reconcileTestsurf は risk.ok!==true を fail-closed
//            として扱い、全 SEC/TESTSURF seed を unchecked に倒す)。
//   files  - fail-safe。Array.isArray(unified?.files) かつ全要素が string のときのみ採用。
//            それ以外は null (呼び出し側の realizedCount が NaN になり complex floor 安全弁へ
//            流れる。空配列 [] は正常な 0 件の realized diff として null と区別して維持する)。
//   struct - fail-open。unified?.struct が object かつ struct.ok===true かつ
//            typeof struct.available==='boolean' かつ format_only/structural (structural は
//            省略可、省略時は [] 扱い) が配列のときのみ採用。それ以外は null。
//   hash   - fail-open。typeof unified?.diffhash?.hash==='string' のときのみその文字列を採用。
//            それ以外は null。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

function parseRiskField(unified) {
  const risk = unified?.risk;
  if (risk != null && typeof risk === 'object' && typeof risk.ok === 'boolean' && Array.isArray(risk.hits)) {
    return risk;
  }
  return { ok: false, hits: [], error: 'secfloor unified proxy unavailable (fail-closed)' };
}

function parseFilesField(unified) {
  const files = unified?.files;
  if (Array.isArray(files) && files.every((f) => typeof f === 'string')) {
    return files;
  }
  return null;
}

function parseStructField(unified) {
  const struct = unified?.struct;
  if (
    struct != null
    && typeof struct === 'object'
    && struct.ok === true
    && typeof struct.available === 'boolean'
    && Array.isArray(struct.format_only)
    && Array.isArray(struct.structural ?? [])
  ) {
    return struct;
  }
  return null;
}

function parseHashField(unified) {
  const hash = unified?.diffhash?.hash;
  return typeof hash === 'string' ? hash : null;
}

export function parseSecfloorFields(unified) {
  return {
    risk: parseRiskField(unified),
    files: parseFilesField(unified),
    struct: parseStructField(unified),
    hash: parseHashField(unified),
  };
}
