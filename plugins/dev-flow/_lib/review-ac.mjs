// review-ac: pr-reviewer の prompt へ issue の acceptance criteria を注入するブロックを組み立てる。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// なぜ必要か: pr-reviewer は「PR の title/body（git-pr が生成した宣言意図）と実 diff の照合」しか
// しておらず、issue の AC を渡されていなかった。evaluator（requirements/AC 忠実性）と
// pr-reviewer（commit 後 PR の品質 + CI）は評価軸が直交しており統合すべきではないが、
// pr-reviewer が AC を「見ないまま approve する」状態は縮められる。
// 実測（journal 145 run）で lgtm 後の merge tier HOLD 理由の最頻値は「AC 未達」8 件 —
// pr-reviewer が approve したものを evaluator 系ゲートが止めている。
//
// ゲート境界は変えない（本ブロックは pr-reviewer への **入力の追加のみ**）。AC 未達を blocking に
// する判定は既存の merge tier HOLD が引き続き担う。
//
// dev-flow lite route（pr-review-lite）と pr-iterate（review#i）の双方が同一文言を使うため
// canonical 化する（片側だけ直すと 2 経路で reviewer の見るものが食い違う）。

/**
 * acceptance criteria ブロックを組み立てる純粋関数。
 *
 * @param {unknown} acceptanceCriteria - issue の AC 配列。未指定 / 非配列 / 空配列 / 全要素が
 *   空文字のときは空文字を返す（fail-open — 単体起動の /pr-iterate は issue context を持たない）。
 * @returns {string} prompt へ連結するブロック（末尾改行つき）。注入しない場合は空文字。
 */
export function acceptanceCriteriaBlock(acceptanceCriteria) {
  if (!Array.isArray(acceptanceCriteria)) return '';
  const items = acceptanceCriteria
    .filter((a) => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (items.length === 0) return '';
  const numbered = items.map((a, idx) => `${idx + 1}. ${a}`).join('\n');
  return `issue の受入条件（acceptance criteria）:\n${numbered}\n`
    + `diff がこれらを満たしているかも判定に含めよ。未達があれば issue として報告せよ`
    + `（severity は他の finding と同じ基準で付ける。AC 未達であることだけを理由に critical へ引き上げない）。\n`;
}
