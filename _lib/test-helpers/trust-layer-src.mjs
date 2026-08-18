// trust-layer routing test 用の source 変換ヘルパ。
//
// 出荷時の `TRUST_LAYER_CONFIG`（_lib/trust-wiring.mjs）は全 layer 'off' で、dev-flow.js の
// trust call site は一切実行されない。一方 routing test は「shadow のとき配線が意図どおり動くか」
// を検証する必要がある（off のまま放置して配線が腐ると、復帰時に無検証のコードが動き出す）。
//
// そこで routing test は本ヘルパで source を shadow へ強制してから VM 実行し、
// **出荷 config が off であること自体**は _lib/trust-layers-off.test.mjs が別途 pin する。
// 両者が揃って初めて「配線は生きている」「出荷時は実行されない」の 2 つの invariant が守られる。

const CONFIG_RE = /const TRUST_LAYER_CONFIG = \{[^}]*\};/;

// dev-flow.js source の TRUST_LAYER_CONFIG を全 layer 'shadow' へ置換して返す。
// 置換が 1 件も起きなければ throw する — const の形が変わったまま
// test が「off の source を流して素通り」する事故を防ぐ（silent no-op 禁止）。
export function forceTrustShadow(src) {
  if (!CONFIG_RE.test(src)) {
    throw new Error(
      'forceTrustShadow: dev-flow.js に TRUST_LAYER_CONFIG 宣言が見つからない'
      + '（_lib/trust-wiring.mjs の宣言形を変えたら本ヘルパの CONFIG_RE も更新すること）',
    );
  }
  return src.replace(
    CONFIG_RE,
    "const TRUST_LAYER_CONFIG = { surfaceproof: 'shadow', evalseal: 'shadow', effectdelta: 'shadow' };",
  );
}

// source から TRUST_LAYER_CONFIG の layer→mode を読み出す（出荷 config の pin 用）。
export function readTrustLayerConfig(src) {
  const m = src.match(CONFIG_RE);
  if (!m) throw new Error('readTrustLayerConfig: TRUST_LAYER_CONFIG 宣言が見つからない');
  const modes = {};
  for (const [, layer, mode] of m[0].matchAll(/(\w+):\s*'(\w+)'/g)) modes[layer] = mode;
  return modes;
}
