---
name: seo-strategy
description: |
  GA4 + GSC + Trends データを統合分析し、包括的な SEO 戦略を構造化 JSON + MD で出力。
  seo-content-planner の上流に位置し、既存記事改善・サイト構造・技術SEO・チャネル戦略を含む全体戦略を提供。
  Use when: (1) SEO全体戦略の策定・更新,
  (2) keywords: SEO戦略, サイト改善, CTR改善, 内部リンク, コンテンツ戦略,
  (3) blog-publish の --skip-seo なしフローの上流ステップとして。
  Accepts args: [--refresh] [--ga-report PATH] [--gsc-report PATH] [--trends-report PATH] [--config PATH]
---

# SEO Strategy

GA4 + GSC + Trends を統合分析し、サイト全体の SEO 戦略を `claudedocs/seo-strategy.json` + `claudedocs/seo-strategy.md` で出力する。

## Usage

```
/seo-strategy [--refresh] [--ga-report PATH] [--gsc-report PATH] [--trends-report PATH] [--config PATH]
```

| Option           | Default                              | Description                     |
| ---------------- | ------------------------------------ | ------------------------------- |
| `--refresh`      | false                                | GA4/GSC/Trends を再取得してから戦略生成 |
| `--ga-report`    | `claudedocs/ga4-report-*.json` (最新) | GA4 レポートパス               |
| `--gsc-report`   | `claudedocs/gsc-report-*.json` (最新) | GSC レポートパス               |
| `--trends-report`| `claudedocs/trends-report-*.json` (最新) | Trends レポートパス          |
| `--config`       | なし（デフォルト値で動作）            | `seo-config.json` パス          |

## Config

プロジェクト固有の設定を `.claude/seo-config.json` で外部化。`--config` 未指定時はデフォルト値で動作（後方互換）。

```json
{
  "site": "example.com",
  "content_path_prefix": "/blog/",
  "content_dir": "content/blog",
  "cluster_keywords": {
    "Cluster Name": ["keyword1", "keyword2"]
  },
  "unclustered_min_impressions": 20,
  "cluster_suggestion_min_impressions": 50,
  "cluster_suggestion_top_n": 5
}
```

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `site` | string | `""` | サイトドメイン（metadata に出力） |
| `content_path_prefix` | string | `"/blog/"` | GA4/GSC の URL パスプレフィックス |
| `content_dir` | string | `"content/blog"` | ブログ MDX ディレクトリ |
| `cluster_keywords` | object | `{}` | クラスタ名→キーワード配列のマッピング |
| `unclustered_min_impressions` | int | `20` | 「その他」クラスタに含める最低 imp |
| `cluster_suggestion_min_impressions` | int | `50` | クラスタ提案に含める最低 imp |
| `cluster_suggestion_top_n` | int | `5` | クラスタ提案の最大数 |

## Workflow

1. **キャッシュ確認**: `claudedocs/seo-strategy.json` の `metadata.generated_at` を確認。TTL 30日以内なら既存を返す（`--refresh` でスキップ）
2. **データ収集**（`--refresh` 時、または元データ不足時）:
   - `/ga-analyzer` で GA4 データ取得
   - `/gsc` で GSC データ取得
   - `/trends-analyzer` で Trends データ取得
3. **データ分析**: `scripts/strategy_analyzer.py` を実行
   ```bash
   python ~/.claude/skills/seo-strategy/scripts/strategy_analyzer.py \
     --ga-report <GA_PATH> --gsc-report <GSC_PATH> --trends-report <TRENDS_PATH> \
     --config .claude/seo-config.json --blog-dir content/blog \
     --project-dir . --output claudedocs/seo-strategy-analysis.json
   ```
4. **ステータス引き継ぎ**: 既存 `seo-strategy.json` がある場合、各要素の `status` を slug/type/channel をキーにマッピングし、新しい戦略に引き継ぐ。新規要素は `"pending"` で初期化。
5. **戦略生成**: 分析結果を読み込み、LLM が以下を判断・生成:

| セクション | 内容 | 判断基準 |
| ---------- | ---- | -------- |
| `existing_article_optimizations` | タイトル/メタ改善、リライト対象 | issues: low_ctr_high_imp, high_bounce |
| `site_structure` | 内部リンク戦略、CTA設計 | pages_per_session, 記事間関連性, codebase_audit.internal_links |
| `technical_seo` | モバイル最適化、CV設定、構造化データ・画像最適化 | device_gap, conversion_tracking, codebase_audit.jsonld/metadata/image_optimization |
| `channel_strategy` | チャネル別改善アクション | channel_metrics の bounce_rate |
| `new_article_directions` | 高ポテンシャル KW 領域 | query_clusters × trends_summary |
| `keyword_competitiveness` | KW 競合性評価・ドメイン権威性分析 | category_performance, domain_authority_map |
| `kpi_targets` | 3ヶ月目標値 | kpi_snapshot からの改善見込み |
| `roadmap` | フェーズ別実行計画 | 優先度×インパクト（codebase_audit の issues severity を考慮） |

6. **出力生成**:
   - `claudedocs/seo-strategy.json` — 構造化戦略（schema は `references/schema.md`）
   - `claudedocs/seo-strategy.md` — エグゼクティブサマリー + アクション一覧

## Skill Delegation

| Skill            | Purpose                    | When           |
| ---------------- | -------------------------- | -------------- |
| ga-analyzer      | GA4 データ取得             | `--refresh` 時 |
| gsc              | GSC データ取得             | `--refresh` 時 |
| trends-analyzer  | Trends データ取得          | `--refresh` 時 |

## Output: seo-strategy.json

構造化戦略 JSON。TTL 30日。詳細 schema は `references/schema.md` を参照。

主要セクション:
- `metadata` — 生成日時・期間・データソース・config パス
- `kpi_snapshot` — GSC/GA4 の現在KPI
- `existing_article_optimizations` — 既存記事の改善アクション
- `site_structure` — 内部リンク・CTA戦略
- `technical_seo` — モバイル・CV追跡の技術課題
- `channel_strategy` — チャネル別改善
- `new_article_directions` — 新規記事の方向性
- `category_performance` — カテゴリ別パフォーマンス（ドメイン権威性ギャップ検知）
- `domain_authority_map` — KW領域別の権威性評価
- `cluster_suggestions` — 未分類クエリからの新クラスタ提案
- `codebase_audit` — コードベース技術SEO監査（JSON-LD、メタデータ、sitemap、内部リンク、画像最適化）
- `kpi_targets` — 目標KPI
- `roadmap` — フェーズ別計画

## Output: seo-strategy.md

人間向けレポート。構成:

1. エグゼクティブサマリー（KPI + 3つの重要発見）
2. 既存記事改善アクション（優先度順）
3. サイト構造改善
4. 技術SEO課題
5. チャネル戦略
6. 新規記事方向性
7. クラスタ提案
8. ロードマップ

## Error Handling

| Error                        | Action                                   |
| ---------------------------- | ---------------------------------------- |
| GA/GSC レポートなし           | `--refresh` を提案、または手動パス指定を案内 |
| strategy_analyzer.py 失敗     | stderr を確認し、入力ファイル形式を検証    |
| 既存 strategy.json が TTL 内  | 既存を返す旨を通知（`--refresh` で上書き可能） |
| config パスが無効             | デフォルト値にフォールバックして続行      |

## Integration: seo-content-planner

seo-content-planner は `seo-strategy.json` を参照して記事テーマ選定を強化:
- `new_article_directions` の KW 領域を優先スコアリング
- `existing_article_optimizations` のリライト対象を新規提案から除外
- `roadmap` のフェーズに沿った記事計画

## Integration: blog-publish

orchestrate.sh のフロー:
```
strategy.needs_generation → /seo-strategy
seo.needs_generation → /seo-content-planner (seo-strategy.json を参照)
```
