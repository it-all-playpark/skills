# inline 生成区間の詳細

`_lib` → workflows の sync generator の起動形・guard・canonical 構造制約の詳細。不変条件は
`.claude/rules/dev-flow.md` を参照。本文中の `.claude/workflows/` は `plugins/dev-flow/` を
root とする plugin 相対パス。`tools/sync-inlines.mjs` のみ repo root。

`.claude/workflows/*.js` 内の `// ==== BEGIN inline: <path> ... ====` 〜 `// ==== END inline: <path> ====`
区間は**生成物であり直接編集禁止**。編集は `_lib` の canonical 側で行い `tools/sync-inlines.mjs --write`
（先頭トークン=スクリプトパスの bare 形。shebang + 実行bit 付与済み — sandbox excludedCommands は
先頭トークンでマッチするため node/cd/bash 前置は付けない）で再生成する（`--check` が CI で全文一致を
検証 — `_lib/workflow-inlines.sync.test.mjs`）。blame は `_lib` 側を見る。

**新規 inline 区間の追加**にも正規経路がある: `tools/sync-inlines.mjs --add <_lib/xxx.mjs> --into
<workflow.js> --after '<挿入位置直前の一意な行（完全一致）>'`（同じく bare 形。node/cd/bash 前置は
付けない）。marker ペアの挿入と canonical 本文の充填・全検証（forbidden tokens / duplicate / decl
collision / 生成後 syntax）を 1 コマンドで validate-then-write するため、途中失敗時も対象ファイルは
不変のままになる。marker 行を Edit/Write で直接書くことは pretool-inline-edit-guard が deny する。
inline-edit-guard / inline-commit-gate は `plugins/dev-flow/hooks/hooks.json` の PreToolUse hook で、
plugin が有効なセッションでは dotfiles 設定に依存せず発火する。
dev-flow plugin を disable すると edit 時（inline-edit-guard）と commit 時（inline-commit-gate）の
2 層が同時に失われ、その間 skills repo の inline 区間は無防備になる。
**git plumbing（hash-object/update-index/checkout-index 等）による迂回は禁止** — 迂回すると guard
の存在理由（生成物の手編集が次回 `--write` で黙って消失する事故防止）が破られる。

sync-inlines の既定 root は `plugins/dev-flow`（`--root` で上書き可）。

**canonical の構造制約**: ESM import / require / Date.now / Math.random を含めない（generator が
コメント除去後のコードを走査して error）。**ファイル全体が inline 可能**であること（export は行頭
接頭辞除去のみで verbatim 注入。export default / export { } は不可）。

**上記以外に canonical のコーディングスタイル制約はない**: 区間全文一致方式のため、template literal
の書き方・const の配置等は自由。

**この generator は harness-capability-bound な橋**（W7 表の capability-bound クラスとは別の軸:
LLM judge 能力依存ではなく harness 機能依存）。workflow loader が ESM import 不可という harness 制約
への対応として存在する。
- 表現: `tools/sync-inlines.mjs` + マーカー区間そのもの
- 再評価トリガ: Claude Code（harness）更新毎に loader の ESM import 可否を再検証し、解禁されたらマーカー区間を `import` 文に置換して generator・統合 sync test ごと撤去する。再検証は `/dev-flow-canary`（read-only capability canary）→ dev-flow-doctor `run-diagnostics --canary` で行う。
