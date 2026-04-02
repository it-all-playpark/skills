---
name: trends-analyzer
description: |
  Google Trendsのデータを取得・分析し、キーワードのトレンドスコアを算出する。
  ga-analyzerの出力JSONからキーワードを自動抽出するか、手動でキーワードを指定可能。
  seo-content-plannerと連携してSEO記事ネタ提案パイプラインの中間ステップとして機能する。
  Use when: (1) Google Trendsでキーワードのトレンドを調べたい,
  (2) GA4データから関連トレンドキーワードを発見したい,
  (3) keywords: Google Trends, トレンド分析, キーワード調査, SEOキーワード, トレンドスコア,
  (4) ga-analyzerの後続ステップとしてトレンドデータを取得したい場合。
  Accepts args: [--ga-report PATH] [--keywords LIST] [--geo GEO] [--timeframe TIMEFRAME] [--top-n N] [--output PATH]
---

# Trends Analyzer

pytrends で Google Trends データを取得し、キーワードごとのトレンドスコアを算出する。

## Pipeline Position

```
ga-analyzer → [trends-analyzer] → seo-content-planner
              ^^^^^^^^^^^^^^^^
              GA JSONからKW抽出 → Trends取得 → スコアリング → JSON出力
```

## Workflow

```
1. 入力判定 → --ga-report（自動KW抽出）or --keywords（手動指定）
2. データ取得 → scripts/trends_fetch.py を実行
3. 結果読み込み → trends_report.json を読み込み
4. 分析・要約 → references/trends_guide.md を参照しトレンドスコアを解釈
```

## Data Fetching

```bash
# GA レポートからキーワード自動抽出
python scripts/trends_fetch.py \
  --ga-report /path/to/ga_report.json \
  --output trends_report.json

# 手動キーワード指定
python scripts/trends_fetch.py \
  --keywords "Claude Code,AI開発,LLM活用" \
  --geo JP \
  --output trends_report.json
```

`--top-n`: GAから抽出するキーワード数（default: 10）
`--geo`: リージョン（default: JP）
`--timeframe`: 期間（default: today 3-m）
`--no-cache`: キャッシュ無効化

## Output Format

`trends_report.json` は以下の構造:

- **keywords**: 抽出元情報付きキーワードリスト
- **trend_scores**: キーワードごとのスコア（avg_interest, trend_direction, rising_queries等）
- **raw_trends**: pytrends生データ（interest_over_time, related_queries）
- **metadata**: geo, timeframe, generated_at

## Resources

- `scripts/trends_fetch.py`: Trends データ取得（リトライ+キャッシュ付き）
- `references/trends_guide.md`: トレンドスコアの解釈ガイド・トラブルシューティング

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log trends-analyzer success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log trends-analyzer failure \
  --error-category <category> --error-msg "<message>"
```
