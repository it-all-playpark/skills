---
name: seo-content-planner
description: |
  GA4実績とGoogle Trendsデータを統合分析し、SEO的に優位な記事ネタを提案する。
  trends-analyzerの出力JSONを入力として、スコアリング・記事提案・編集カレンダーをMarkdownレポートで出力。
  GSCデータの統合に対応し、content-strategy.json形式での出力もサポート。
  ga-analyzer → trends-analyzer → seo-content-planner のパイプライン最終ステップ。
  Use when: (1) SEOに強い記事ネタを発見したい,
  (2) GA4データとトレンドを掛け合わせてコンテンツ戦略を立てたい,
  (3) keywords: SEO記事, コンテンツ計画, 記事ネタ, 編集カレンダー, SEOスコア, コンテンツプランニング,
  (4) trends-analyzerの後続ステップとして記事提案を生成したい場合。
  Accepts args: [--trends-report PATH] [--ga-report PATH] [--gsc-report PATH] [--output PATH] [--output-format content_plan|content_strategy] [--top-n N]
---

# SEO Content Planner

GA4実績 × Google Trendsデータから、SEOスコア付きの記事ネタ提案レポートを生成する。

## Pipeline Position

```
ga-analyzer + gsc_fetch.py → trends-analyzer → [seo-content-planner] → content-strategy.json
                                                ^^^^^^^^^^^^^^^^^^^
                                                GA + Trends + GSC統合 → スコアリング → JSON / Markdown
```

## Workflow

### 逐次実行（推奨）

```
1. /ga-analyzer でGA4データ取得 → ga_report.json
2. python scripts/gsc_fetch.py でGSCデータ取得 → gsc_report.json
3. /trends-analyzer でトレンド取得 → trends_report.json
4. スコアリング → python scripts/seo_planner.py を実行
5. content-strategy.json or content_plan.json を読み込み → references/scoring_guide.md を参照して Markdown レポート生成
```

### ワンショット実行

全ステップをまとめて実行する場合:
1. ga-analyzer を実行 → ga_report.json 生成
2. trends-analyzer を `--ga-report ga_report.json` で実行 → trends_report.json 生成
3. 本スキルを `--trends-report trends_report.json --ga-report ga_report.json` で実行

## Data Processing

```bash
# フルパイプライン（GA + GSC + Trends → content-strategy.json）
python scripts/gsc_fetch.py \
  --site "sc-domain:playpark.co.jp" \
  --output claudedocs/gsc-report-YYYY-MM.json --days 28

python scripts/seo_planner.py \
  --trends-report claudedocs/trends-report-YYYY-MM.json \
  --ga-report claudedocs/ga4-report-YYYY-MM.json \
  --gsc-report claudedocs/gsc-report-YYYY-MM.json \
  --output claudedocs/content-strategy.json \
  --output-format content_strategy

# レガシー（content_plan.json形式、従来互換）
python scripts/seo_planner.py \
  --trends-report trends_report.json \
  --output content_plan.json

# Trends のみ（GA・GSCデータなし）
python scripts/seo_planner.py \
  --trends-report trends_report.json \
  --output content_plan.json
```

`--top-n`: 出力候補数（default: 15）

## Report Generation

`content_plan.json` を読み込んだ後、`references/scoring_guide.md` のレポートテンプレートに従い Markdown レポートを生成する。

レポート構成:
1. **サマリー**: 候補数、即時アクション件数、平均SEOスコア
2. **記事ネタ候補（優先度順）**: SEOスコア、トレンド方向、難易度、推奨時期、記事切り口
3. **クロス分析テーブル**: キーワード × スコア × トレンド一覧
4. **編集カレンダー**: 推奨時期順のリスト

## Resources

- `scripts/seo_planner.py`: GA + Trends統合スコアリング
- `scripts/gsc_fetch.py`: GSC API ラッパー（Search Analytics取得）
- `references/scoring_guide.md`: スコアリング基準・レポートテンプレート
