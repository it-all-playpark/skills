// review-delta: pr-iterate の review#i（i ≥ 2）を fix delta（前 round の head sha .. 現在 HEAD）に絞る
// ための純粋関数群。I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// なぜ必要か: review#i（i ≥ 2）が毎 round 全 PR diff を cold で読み直すと、安定したコードに
// 新しい主観的 major を捻り出す churn（moving target）が生まれる。「既出は対応済み前提で読め」
// という指示だけでは抑止が指示ベースに留まるため、delta を sha 範囲で機械的に確定し
// 「読んでいないコードには新しい major を出せない」構造にする。
//
// 不変条件:
//   - delta の範囲は sha で機械的に決める。reviewer に「必要なら全体も読め」の裁量は渡さない
//     （裁量を残すと指示ベースに戻り churn が復活する）。
//   - sha が確定できない round は **full にフォールバック**する（fail-open）。delta を空扱いにして
//     「新規なし → approve」へ倒さない。sha_prev === sha_now（fix が commit を積まなかった）も
//     同じ理由で full に倒す（空 delta を approve の根拠にしない）。
//   - delta 外の regression は CI / Final reconcile の test 再実行が担当（ゲート境界は不変）。

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * delta 範囲に使える sha か（7〜40 桁 hex）。exec-proxy が空文字 / エラー文を返した場合を弾く。
 * @param {unknown} s
 * @returns {boolean}
 */
export function isDeltaSha(s) {
  return typeof s === 'string' && SHA_RE.test(s.trim());
}

/**
 * review#iteration の diff 範囲を決める。
 *
 * @param {{iteration: number, shaPrev: unknown, shaNow: unknown}} p
 *   shaPrev: 前 round の review 時点の head sha / shaNow: 現在の head sha（fix 後の ensure-committed が返す）
 * @returns {{scope: 'full'|'delta', range: string|null, reason: string|null}}
 *   reason は full にフォールバックした理由（iteration 1 は null）。呼び出し側が log に出す。
 */
export function resolveReviewScope({ iteration, shaPrev, shaNow }) {
  if (!(Number(iteration) >= 2)) return { scope: 'full', range: null, reason: null };
  if (!isDeltaSha(shaPrev)) return { scope: 'full', range: null, reason: 'sha_prev_unavailable' };
  if (!isDeltaSha(shaNow)) return { scope: 'full', range: null, reason: 'sha_now_unavailable' };
  const prev = shaPrev.trim();
  const now = shaNow.trim();
  if (prev.toLowerCase() === now.toLowerCase()) return { scope: 'full', range: null, reason: 'sha_unchanged' };
  return { scope: 'delta', range: `${prev}..${now}`, reason: null };
}

/**
 * review#i（i ≥ 2、delta 確定時）の prompt へ連結する delta ブロック。
 * @param {{shaPrev: string, shaNow: string}} p
 * @returns {string} 末尾改行つき
 */
export function reviewDeltaBlock({ shaPrev, shaNow }) {
  const range = `${shaPrev.trim()}..${shaNow.trim()}`;
  return `delta_range: ${range}\n`
    + `\`git diff ${range}\` が fix delta。既出 findings が delta で解消されたかの確認と、`
    + `delta 内の新規 critical/major のみ報告せよ。PR 全 diff の再読は不要。\n`;
}

/**
 * `git diff --shortstat A..B` の stdout（1 行）から変更行数（insertions + deletions）を取り出す。
 * 空文字は差分なし = 0。非文字列 / 数値を含まない文字列は null（不明）。
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseShortstatLines(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return 0;
  const ins = /(\d+) insertions?\(\+\)/.exec(t);
  const del = /(\d+) deletions?\(-\)/.exec(t);
  if (!ins && !del) return /\d+ files? changed/.test(t) ? 0 : null;
  return (ins ? Number.parseInt(ins[1], 10) : 0) + (del ? Number.parseInt(del[1], 10) : 0);
}
