# Agent Prompts

## Search Agent (model: haiku)

全カテゴリ共通。`model: "haiku"` で起動する。

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
      "source_tier": 1-4
    }
  ]
}

source_tier の判定基準:
- 1: docs.anthropic.com, github.com/anthropics, anthropic.com/blog
- 2: TechCrunch, The Verge, Ars Technica, Hacker News, The Information
- 3: GitHub Discussions, dev.to, Zenn, HN comments
- 4: X/Twitter, 個人ブログ（単独では不採用、裏付け必要）
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
{AI / Claude Code に関連する部分のみを引用。最大500語/URL}
```

## Fact Check Agent (model: sonnet)

```
以下の情報を公式ソースと照合し、各項目の正確性を検証してください。
検証対象: [Step 2-3 で収集した主要項目のリスト]

検証方法:
- Claude Code: WebFetch で GitHub CHANGELOG / Releases を取得し照合
- Claude API: WebFetch で docs.anthropic.com/release-notes を取得し照合
- AI Industry: WebSearch で複数の信頼メディアに報じられているか確認

各項目について「確認済み / 未確認 / 誤り」を判定し、誤りがあれば正しい情報を返してください。
```

## Practical Tips Agent (model: opus)

```
Claude Code の以下の新機能について、実践的な tips を調べてください。
対象: [Step 2 で見つかった新機能リスト]

各機能について:
- settings.json の設定例（JSON コード）
- bash コマンド例
- 具体的なユースケース（「こういう場面で使える」）

公式ドキュメント（code.claude.com/docs, github.com/anthropics）を最優先ソースとしてください。
概論的な「XYZ が重要になった」は不要。「この JSON を settings.json に追加すると Y ができる」レベルの具体性で。
```
