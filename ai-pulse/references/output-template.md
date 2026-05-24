# Output Template: pulse-YYYY-MM-DD.md

LLM はこのテンプレートに従って最終 Markdown を生成する。
空セクションは残さず、該当なしのカテゴリは「特筆なし」と明記する。

```markdown
# AI Pulse — YYYY-MM-DD

- 取得範囲: 直近 N 日
- 取得ソース: smol, willison, latent, hfpapers
- 記事総数: <件>
- 生成: ai-pulse skill

---

## 今日触るべき 1 つ

- **対象**: <ツール名 / モデル名 / コードリポジトリ名>
- **理由**: <なぜ今日触る価値があるか 1 行>
- **最初のコマンド**: `<実行コマンドや URL>`

---

## Claude Code / Anthropic

### <記事タイトル>
- <要約 1 行目: 何が起きたか>
- <要約 2 行目: 開発者への影響>
- ソース: [<サイト名>](<URL>)

（記事ごとに上記を繰り返し。0 件なら「特筆なし」のみ）

---

## 新モデル / リリース

（同上）

---

## Eval / LLMOps

（同上）

---

## プロンプティング / 技法

（同上）

---

## 論文 / 研究

（同上。HF Daily Papers はここに集約。1 記事 = 1 論文）

---

## その他

（同上）

---

## ソース別 raw 一覧

<details>
<summary>Smol AI News (N 件)</summary>

- [<タイトル>](<URL>) — <1 行要約>
- ...

</details>

<details>
<summary>Simon Willison (N 件)</summary>

（同上）

</details>

<details>
<summary>Latent Space (N 件)</summary>

（同上）

</details>

<details>
<summary>HuggingFace Daily Papers (N 件)</summary>

（同上）

</details>
```

## 編集ルール

- 「触るべき 1 つ」は必ず先頭に置く（ガイド §0 の「読む量より触る量」原則）
- 各記事の要約は 3 行（タイトル除く）
- カテゴリ内では「重要度の高い順」に並べる
- 重複記事は最も信頼性の高いソースのみ残し、他は raw 一覧の `<details>` に格納
- 引用ブロック・コードブロックは原文 URL を必ず併記
