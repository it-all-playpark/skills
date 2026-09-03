/**
 * dev-flow-markers.mjs — dev-flow テスト用マーカー定数
 *
 * dev-flow.js のソースに含まれる再利用 prompt トークンを定数として export する。
 * test 側でこれらを import して使うことで、literal の分散を防ぎ
 * dev-flow.js の canonical source との pin を一箇所で管理できる。
 */

/**
 * evaluator への focus 注入で使われるテスト弱体化チェック用マーカー文字列。
 * dev-flow.js の生ソースに含まれていることを test-helpers.test.mjs で pin している。
 */
export const TEST_WEAKENING = 'テスト弱体化';
