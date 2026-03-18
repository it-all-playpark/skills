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
  "status": "pending|done|skipped",
  "actions": [
    {
      "type": "title_meta|content_refresh|schema_markup|internal_link",
      "field": "title|description (title_meta のみ)",
      "current": "現在の値 (あれば)",
      "suggestion": "改善提案",
      "rationale": "根拠（メトリクス付き）",
      "status": "pending|done|skipped"
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
      "status": "pending|done|skipped",
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
      "status": "pending|done|skipped",
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
    "status": "pending|done|skipped",
    "issues": [
      {
        "metric": "metric_name",
        "current": float,
        "target": float,
        "actions": ["action1", "action2"],
        "status": "pending|done|skipped"
      }
    ]
  },
  "conversion_tracking": {
    "priority": "critical|high|medium",
    "status": "pending|done|skipped",
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
  "status": "pending|done|skipped",
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
  "status": "pending|done|skipped",
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

## category_performance

strategy_analyzer.py が出力するカテゴリ別集計。ドメイン権威性ギャップの検知に使用。

```json
{
  "tech-tips": {
    "article_count": 20,
    "total_impressions": 12000,
    "total_clicks": 800,
    "avg_impressions": 600,
    "total_pageviews": 3000,
    "zero_impression_count": 1,
    "zero_impression_rate": 5.0
  },
  "solutions": {
    "article_count": 10,
    "total_impressions": 440,
    "total_clicks": 30,
    "avg_impressions": 44,
    "total_pageviews": 200,
    "zero_impression_count": 8,
    "zero_impression_rate": 80.0
  }
}
```

## domain_authority_map[]

KW領域別の権威性評価。query_clusters から算出。

```json
{
  "area": "Claude Code",
  "impressions": 5000,
  "clicks": 400,
  "ctr": 8.0,
  "strength": "strong"
}
```

strength の判定ロジック:
- `strong`: CTR ≥ 5% かつ clicks ≥ 20
- `moderate`: impressions ≥ 100
- `weak`: それ以外

## status フィールド共通仕様

アクション可能な要素には `status` フィールドを持たせ、進捗を追跡する。

| 値 | 意味 |
| --- | ---- |
| `pending` | 未着手（デフォルト） |
| `done` | 対応完了 |
| `skipped` | 意図的にスキップ |

### 対象要素

| セクション | レベル |
| ---------- | ------ |
| `existing_article_optimizations[]` | 記事単位 + `actions[]` 個別 |
| `site_structure.internal_linking[]` | 施策単位 |
| `site_structure.cta_strategy[]` | 施策単位 |
| `technical_seo.mobile` | カテゴリ単位 + `issues[]` 個別 |
| `technical_seo.conversion_tracking` | カテゴリ単位 |
| `channel_strategy[]` | チャネル単位 |
| `new_article_directions[]` | 方向性単位 |

### 記事レベル status の導出

`existing_article_optimizations[].status` は全 `actions[].status` から導出:
- 全 action が `done` or `skipped` → 記事 status = `done`
- 1つ以上 `done` or `skipped` で残り `pending` → 記事 status = `pending`（部分対応中）
- 全 action が `pending` → 記事 status = `pending`

### リフレッシュ時のステータス保持

`--refresh` で戦略を再生成する際、既存 `seo-strategy.json` の `status` 値を引き継ぐ:
1. 既存 JSON を読み込み、slug/type/channel 等をキーに status をマッピング
2. 新規生成された要素のうち、既存と一致するものは status を引き継ぐ
3. 新規要素は `"pending"` で初期化
4. 既存にあったが新規に含まれない `done` 要素は出力から除外

## codebase_audit

`strategy_analyzer.py` が `--project-dir` で指定されたプロジェクトルートをスキャンし、技術SEO課題をソースコードから検出する。

```json
{
  "jsonld": {
    "available_types": ["OrganizationJsonLd", "ArticleJsonLd", "..."],
    "global_schemas": ["OrganizationJsonLd", "LocalBusinessJsonLd"],
    "page_usage": {
      "app/blog/[slug]/page.tsx": ["ArticleJsonLd", "BreadcrumbJsonLd"]
    },
    "pages_without_jsonld": ["app/about/page.tsx"],
    "issues": [{ "type": "no_jsonld", "page": "...", "severity": "low", "description": "..." }]
  },
  "metadata": {
    "pages": [
      {
        "path": "app/blog/[slug]/page.tsx",
        "metadata_type": "generateMetadata|static|none",
        "has_title": true,
        "has_description": true,
        "has_openGraph": true,
        "has_twitter": true,
        "has_canonical": false,
        "issues": ["missing_canonical"]
      }
    ],
    "summary": {
      "total_pages": int,
      "with_metadata": int,
      "with_openGraph": int,
      "with_canonical": int
    }
  },
  "sitemap": {
    "file": "app/sitemap.ts",
    "revalidate": 3600,
    "content_types": ["static", "blog", "blog_category", "blog_hub", "news"],
    "priority_values": [1.0, 0.9, 0.85, 0.8, 0.75],
    "issues": []
  },
  "robots": {
    "file": "app/robots.ts",
    "disallow_paths": ["/api/", "/contact/thanks"],
    "sitemap_url": "https://...",
    "issues": []
  },
  "internal_links": {
    "total_articles": int,
    "articles_with_outgoing": int,
    "articles_with_incoming": int,
    "orphan_articles": ["slug1", "slug2"],
    "orphan_rate": float,
    "broken_links": [{ "source": "slug", "target": "/blog/..." }],
    "link_graph_sample": {
      "slug": { "outgoing": ["slug2"], "incoming": ["slug3"] }
    },
    "issues": [
      { "type": "high_orphan_rate", "severity": "high", "rate": float, "description": "..." },
      { "type": "broken_internal_link", "severity": "medium", "source": "...", "target": "...", "description": "..." }
    ]
  },
  "image_optimization": {
    "next_config_formats": ["avif", "webp"],
    "files_using_next_image": int,
    "files_using_raw_img": int,
    "blog_images": { "total": int, "webp": int, "non_webp": int, "no_image": int },
    "issues": [
      { "type": "raw_img_tag", "severity": "medium", "count": int, "description": "..." },
      { "type": "non_webp_blog_images", "severity": "low", "slugs": ["..."], "description": "..." }
    ]
  },
  "noindex_canonical": {
    "noindex_pages": [],
    "pages_with_canonical": ["app/solutions/page.tsx"],
    "pages_without_canonical": ["app/blog/[slug]/page.tsx"],
    "issues": [
      { "type": "missing_canonical", "page": "...", "severity": "medium", "description": "..." }
    ]
  },
  "summary": {
    "total_issues": int,
    "critical": int,
    "high": int,
    "medium": int,
    "low": int
  }
}
```

### issue.severity 一覧

| severity | 意味 | 例 |
| -------- | ---- | --- |
| `critical` | SEO をブロックする問題 | 重要ページの意図しない noindex |
| `high` | 大きな改善余地 | 記事の 90%+ が孤立（内部リンクなし） |
| `medium` | 改善推奨 | ブログ記事に canonical 未設定、raw `<img>` 使用 |
| `low` | あれば望ましい | 一部ページに JSON-LD なし、非 WebP 画像 |

### LLM による活用指針

- `codebase_audit.internal_links` → `site_structure.internal_linking` の施策に反映
- `codebase_audit.jsonld.pages_without_jsonld` → `technical_seo` で構造化データ追加を提案
- `codebase_audit.metadata` → `existing_article_optimizations` の action.type に `meta_fix` を追加
- `codebase_audit.image_optimization` → `technical_seo.mobile` の改善提案に反映
- `codebase_audit.noindex_canonical` → `technical_seo` でcanonical設定の優先度判断
- `codebase_audit.summary` → `roadmap` のフェーズ優先度に severity を加味

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
