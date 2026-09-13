/**
 * dev-flow-markers.mjs — dev-flow テスト用マーカー定数
 *
 * dev-flow.js が evaluator focus_areas へ注入する green-fix 監査 concern は、green-fix implementer の
 * 申告（files / summary）を構造的な形（`[#<n>] <summary>` の番号付き echo と files の JSON）で
 * データ echo する。テストはこの echo を観測して注入の有無を判定する（「テスト弱体化」等の日本語
 * 文言は言い回しの変更で落ちるため pin しない — issue #636 AC-1）。
 */

/**
 * green-fix 監査 concern が evaluator prompt に注入されたときに現れる、n 回目の green-fix summary の
 * echo 文字列（`[#n] <summary>`）を返す。
 *
 * @param {number} n - 1 始まりの green-fix 回数
 * @param {string} summary - green-fix implementer stub が返した summary
 * @returns {string}
 */
export function greenFixAuditEcho(n, summary) {
  return `[#${n}] ${summary}`;
}
