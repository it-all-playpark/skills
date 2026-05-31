// 正の整数 arg を正規化する。dev-flow / pr-iterate の entrypoint 共通。
// 受理: bare string '120' / number 120 / array ['120'] / object {issue:'120'} | {pr:'120'}
// 拒否(throw): 空 / 未展開テンプレート '{' / '0' / 負数 / 小数 / 非数字混入
// NOTE: name に対応するキー（args[name]）と bare/array 形式のみを解決する。
//       cross-name fallback（例: name='pr' のときに args.issue を採用する）は
//       型安全性を損なう footgun のため意図的に除外している。
//
// INLINE COPY POLICY: .claude/workflows/{dev-flow,pr-iterate}.js は Claude Code の
// dynamic workflow ローダーが独自の VM コンテキストで評価するため、ESM の
// import 文（`import { resolvePositiveIntArg } from '../../_lib/resolve-arg.mjs'` 等）
// は使用できない。そのため両ファイルに関数本体を inline コピーしており、
// _lib/resolve-arg.sync.test.mjs がその byte 一致を CI で保証する。
// この関数を修正する際は、必ず両 workflow ファイルの inline コピーも同期すること。
export function resolvePositiveIntArg(args, name) {
  const raw = (typeof args === 'string' || typeof args === 'number')
    ? args
    : (args?.[name] ?? args?.[0]);
  const s = String(raw ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`${name}: 正の整数が必要です（受信: ${JSON.stringify(s)}）`);
  }
  return s;
}
