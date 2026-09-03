# Input Schema: blog-seo-improve

依存スキルの出力から必要なフィールド定義。

## GSC出力（gsc skill）

```json
{
  "rows": [
    {
      "query": "claude code 使い方",
      "page": "https://www.playpark.co.jp/blog/claude-code-guide",
      "clicks": 45,
      "impressions": 340,
      "ctr": 0.132,
      "position": 8.2
    }
  ]
}
```

**必須フィールド**: `query`, `page`, `clicks`, `impressions`, `ctr`, `position`

## GA4出力（ga-analyzer skill）

```json
{
  "pages": [
    {
      "pagePath": "/blog/claude-code-guide",
      "sessions": 120,
      "bounceRate": 0.78,
      "engagementRate": 0.22,
      "avgSessionDuration": 45.3
    }
  ]
}
```

**必須フィールド**: `pagePath`, `sessions`, `bounceRate`, `engagementRate`, `avgSessionDuration`

## seo-strategy出力（seo-strategy skill）

```json
{
  "clusters": [
    {
      "name": "Claude Code",
      "articles": [
        {
          "slug": "claude-code-guide",
          "date": "2026-02-15",
          "keywords": ["claude code", "使い方"]
        }
      ]
    }
  ],
  "optimization_opportunities": [
    {
      "type": "low_ctr",
      "page": "/blog/claude-code-guide",
      "current_ctr": 0.012,
      "impressions": 340,
      "suggestion": "title改善でCTR向上の余地"
    }
  ]
}
```

**必須フィールド**:
- `clusters[].articles[]`: クラスタ所属の記事一覧
- `optimization_opportunities[]`: 改善機会の一覧
