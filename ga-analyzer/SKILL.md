---
name: ga-analyzer
description: |
  GA4（Google Analytics 4）データを分析し、企業サイト/LP向けの改善アドバイスを提供。
  Use when: (1) GA分析、アクセス解析、サイト改善の相談,
  (2) keywords: GA4, Google Analytics, アクセス解析, PV, セッション, 直帰率, CV改善,
  (3) ユーザーがGA4のデータを分析してほしい、サイト改善のアドバイスがほしい場合。
  Accepts args: [--property-id ID] [--oauth-client PATH] [--period 7d|30d|90d] [--focus traffic|conversion|content|all]
---

# GA4 Analyzer

GA4 Data APIでアクセス解析データを取得し、企業サイト/LP向けの改善提案を行う。

## Workflow

```
1. セットアップ確認 → 未完了なら references/setup_guide.md を案内
2. データ取得 → scripts/ga_fetch.py を実行
3. データ読み込み → 生成されたJSONを読み込み
4. 分析・提案 → references/metrics_guide.md を参照しながらレポート作成
```

## Data Fetching

`scripts/ga_fetch.py --help` で全オプション確認可能。基本コマンド:

```bash
python scripts/ga_fetch.py \
  --property-id PROPERTY_ID \
  --oauth-client /path/to/client_secret.json \
  --output ga_report.json
```

`--report-type`: full(default) | traffic | conversion | content

## Report Output

Markdownレポートは以下の構成で生成:

1. **サマリー**: 主要KPI + 3つの重要な発見
2. **トラフィック/CV/コンテンツ分析**: データに基づく現状把握
3. **改善提案（優先度順）**: [高] 即時 / [中] 短期 / [低] 中長期

## Resources

- `scripts/ga_fetch.py`: GA4データ取得（OAuth/SA両対応）
- `references/setup_guide.md`: API初期設定手順（OAuth推奨）
- `references/metrics_guide.md`: メトリクス解釈・ベンチマーク・改善ポイント
