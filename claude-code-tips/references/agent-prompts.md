# Agent Prompts

## Search Agent (model: haiku / sonnet)

Categories A-D は `model: "haiku"`、E-F は `model: "sonnet"` で起動する。

```
カテゴリ「{CATEGORY_NAME}」について、以下の検索クエリで WebSearch を実行してください。

検索クエリ:
{QUERIES}

日付範囲: {DATE_RANGE}

【重要】WebFetch は実行しない。WebSearch の結果のみを以下のフォーマットで返却すること。
要約・分析・評価は一切不要。検索結果の生データを構造化して返すだけ。

返却フォーマット（JSON）:
{
  "category": "{CATEGORY_ID}",
  "results": [
    {
      "title": "記事タイトル",
      "url": "https://...",
      "snippet": "検索結果のスニペット（そのまま）",
      "source_tier": 1-4,
      "has_code_example": true/false
    }
  ]
}

source_tier の判定基準:
- 1: code.claude.com, github.com/anthropics, anthropic.com/blog
- 2: ClaudeCodeLog (X), Anthropic 社員のポスト
- 3: GitHub repos, Zenn, dev.to, HN threads（実装記事）
- 4: X/Twitter, Reddit, 個人ブログ（Tier 4 はコード例がある場合のみ含める）
```

## Fetch Agent (model: haiku)

Step 4 の詳細取得用。URL リストを受け取り、WebFetch して生テキストを返す。

```
以下の URL リストに対して WebFetch を実行し、各ページの関連部分を抽出してください。

URL リスト:
{URLS}

【重要】分析・要約は不要。以下のフォーマットで生データを返すこと。

返却フォーマット:
## {URL}
**タイトル**: {ページタイトル}
**関連引用**:
{Claude Code に関連する部分のみを引用。最大500語/URL}
```

## Fact Check Agent (model: opus)

```
以下の Claude Code tips を公式ソースと照合し、正確性を検証してください。
検証対象: [Step 2-4 で収集した tips リスト]

検証方法:
- WebFetch で GitHub CHANGELOG.md / Releases を取得し、該当バージョン・機能の存在を確認
- WebFetch で code.claude.com/docs の該当ページを取得し、設定キー・オプションの正確性を確認
- settings.json のキー名、hook イベント名、環境変数名が正確か照合
- バージョン要件がある場合、最低必要バージョンを特定

各項目について以下を判定:
- 確認済み: 公式ソースで裏付けあり
- バージョン依存: 特定バージョン以降でのみ有効（バージョン番号を明記）
- 未確認: 公式ソースで裏付けが取れないがコミュニティで報告あり
- 誤り: 公式ソースと矛盾（正しい情報を記載）

特に JSON 設定のキー名・構造は1文字でも間違うと動作しないため、厳密に照合すること。
```

## Implementation Agent (model: opus)

```
以下の Claude Code tips について、コピペで即座に使える実装例を構築してください。
対象: [Step 2-4 で見つかった tips リスト]

各 tip について:

1. **settings.json の設定例**（該当する場合）
   - 完全な JSON パス（どこに追加するか明確に）
   - 必須キーと任意キーを区別
   - 実際の値の例（プレースホルダーではなく動くもの）

2. **bash コマンド/スクリプト例**（該当する場合）
   - 環境変数の設定方法（fish / bash / zsh）
   - CLI フラグの完全な使用例

3. **CLAUDE.md / AGENTS.md の記述例**（該当する場合）
   - 効果的な書き方のパターン
   - アンチパターン（やりがちだが効果がない書き方）

4. **組み合わせパターン**
   - 単体ではなく、他の設定と組み合わせると効果が高まるケース
   - 例: hooks + allowRules + MCP の連携パターン

概念の説明は最小限に。「この JSON を settings.json に追加すると Y ができる」レベルの具体性で。
公式ドキュメント（code.claude.com/docs, github.com/anthropics）を最優先ソースとすること。
```
