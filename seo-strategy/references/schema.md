# seo-strategy.json Schema

## 配置

`claudedocs/seo-strategy.json` — サイト全体の SEO 戦略。TTL: 30日。

## Top-level Structure

| Key | Type | Description |
| --- | ---- | ----------- |
| `metadata` | object | 生成日時・期間・データソース |
| `kpi_snapshot` | object | GSC/GA4 の現在 KPI |
| `existing_article_optimizations` | array | 既存記事の改善アクション |
| `site_structure` | object | 内部リンク・CTA 戦略 |
| `technical_seo` | object | モバイル・CV 追跡の技術課題 |
| `channel_strategy` | array | チャネル別改善 |
| `new_article_directions` | array | 新規記事の方向性 |
| `cluster_suggestions` | array | 未分類クエリからの新クラスタ提案 |
| `kpi_targets` | object | 目標 KPI |
| `roadmap` | object | フェーズ別計画 |

## metadata

```json
{
  "generated_at": "ISO 8601",
  "period": "YYYY-MM-DD 〜 YYYY-MM-DD",
  "site": "config.site の値（config 未指定時は空文字列）",
  "config": "seo-config.json のパス or null",
  "data_sources": {
    "ga_report": "path or null",
    "gsc_report": "path or null",
    "trends_report": "path or null"
  },
  "ttl_days": 30,
  "version": "1.0"
}
```

## kpi_snapshot

```json
{
  "gsc": { "clicks": int, "impressions": int, "avg_ctr": float, "avg_position": float },
  "ga4": {
    "active_users": int, "bounce_rate": float, "pages_per_session": float,
    "engagement_rate": float, "conversion_configured": bool
  }
}
```

## existing_article_optimizations[]

```json
{
  "slug": "article-slug",
  "url": "/blog/article-slug",
  "priority": "high|medium|low",
  "actions": [
    {
      "type": "title_meta|content_refresh|schema_markup|internal_link",
      "field": "title|description (title_meta のみ)",
      "current": "現在の値 (あれば)",
      "suggestion": "改善提案",
      "rationale": "根拠（メトリクス付き）"
    }
  ],
  "metrics": {
    "impressions": int, "clicks": int, "ctr": float,
    "avg_position": float, "bounce_rate": float,
    "engagement_rate": float, "pageviews": int
  },
  "target_queries": ["query1", "query2"],
  "expected_impact": "改善見込みの記述"
}
```

### action.type 一覧

| type | 用途 |
| ---- | ---- |
| `title_meta` | タイトル/メタディスクリプション改善 |
| `content_refresh` | コンテンツリライト |
| `schema_markup` | 構造化データ追加 |
| `internal_link` | 内部リンク追加 |

## site_structure

```json
{
  "internal_linking": [
    {
      "type": "series_linking|pillar_page|cross_category",
      "priority": "high|medium|low",
      "description": "施策説明",
      "articles": ["slug1", "slug2"],
      "rationale": "根拠",
      "expected_impact": "改善見込み"
    }
  ],
  "cta_strategy": [
    {
      "type": "blog_to_service|blog_to_contact|in_article",
      "priority": "high|medium|low",
      "description": "施策説明",
      "target_page": "/path",
      "rationale": "根拠",
      "expected_impact": "改善見込み"
    }
  ]
}
```

## technical_seo

```json
{
  "mobile": {
    "priority": "high|medium|low",
    "issues": [
      {
        "metric": "metric_name",
        "current": float,
        "target": float,
        "actions": ["action1", "action2"]
      }
    ]
  },
  "conversion_tracking": {
    "priority": "critical|high|medium",
    "configured": bool,
    "required_events": [
      { "event": "event_name", "description": "説明" }
    ],
    "rationale": "根拠"
  }
}
```

## channel_strategy[]

```json
{
  "channel": "linkedin|facebook|qiita|twitter|organic",
  "priority": "high|medium|low",
  "issue": "課題の要約",
  "actions": ["action1", "action2"],
  "metrics": { "sessions": int, "bounce_rate": float }
}
```

## new_article_directions[]

```json
{
  "keyword_area": "キーワード領域名",
  "evidence": "根拠データの要約",
  "suggested_angles": ["切り口1", "切り口2"],
  "priority": "high|medium|low",
  "funnel": "認知|興味|検討|導入"
}
```

## cluster_suggestions[]

`strategy_analyzer.py` が未分類クエリから自動提案する新クラスタ候補。

```json
{
  "suggested_keyword": "共通トークン",
  "queries": ["query1", "query2", "..."],
  "query_count": int,
  "total_impressions": int,
  "total_clicks": int
}
```

LLM はこの提案を確認し、有用なものを `seo-config.json` の `cluster_keywords` に追加する判断を行う。

## kpi_targets

```json
{
  "timeframe": "3ヶ月",
  "targets": [
    {
      "metric": "metric_name",
      "current": float,
      "target": float,
      "driver": "改善施策"
    }
  ]
}
```

## roadmap

```json
{
  "phases": [
    {
      "phase": int,
      "name": "フェーズ名",
      "timeframe": "期間",
      "focus": "フォーカス領域",
      "actions": ["action1", "action2"]
    }
  ]
}
```
