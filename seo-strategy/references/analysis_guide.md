# SEO Strategy Analysis Guide

strategy_analyzer.py が使用する分析手法・閾値・判断基準。

## Issue Auto-Detection Thresholds

| Issue | Condition | 意味 |
| ----- | --------- | ---- |
| `low_ctr_high_imp` | imp ≥ 100 & CTR ≤ 3.0% | 表示多いが CTR 低い → タイトル/メタ改善 |
| `high_bounce` | bounce_rate ≥ 65% | 離脱率高い → コンテンツ不一致 or UX 問題 |
| `low_engagement` | engagement_rate ≤ 35% | エンゲージ低い → コンテンツ品質/導線問題 |
| `position_opportunity` | 8 ≤ position ≤ 20 | 2ページ目圏内 → 改善で1ページ目に |
| `zero_click` | imp ≥ 50 & clicks = 0 | 表示あるが CTR ゼロ → 深刻な不一致 |

## 優先度判定ガイドライン（LLM 用）

### existing_article_optimizations の priority

| Priority | 条件 |
| -------- | ---- |
| high | issues に 2+ 該当 OR imp ≥ 500 で CTR < 3% |
| medium | issues に 1 該当 AND imp ≥ 100 |
| low | issues 1 該当 AND imp < 100 |

### site_structure の priority

| Priority | 条件 |
| -------- | ---- |
| high | pages_per_session < 1.2 OR 関連記事群に相互リンクなし |
| medium | pages_per_session 1.2-1.5 OR CTA 不足 |
| low | すでに内部リンク構造あり、微調整 |

### new_article_directions の priority

| Priority | 条件 |
| -------- | ---- |
| high | クラスタ imp ≥ 500 AND 既存記事なし/不足 |
| medium | クラスタ imp 100-500 OR トレンド上昇中 |
| low | imp < 100 AND トレンド横ばい |

## Query Clustering ロジック

strategy_analyzer.py の keyword-based clustering は `seo-config.json` の `cluster_keywords` から読み込む。

`--config` 指定時: config 内の `cluster_keywords` マッピングを使用してクエリを分類。
`--config` 未指定時: `cluster_keywords` が空のため、全クエリが未分類扱いとなり `cluster_suggestions` のみが生成される。

### 設定例（playpark.co.jp）

```json
{
  "cluster_keywords": {
    "Claude Code": ["claude code", "claude-code", "claude settings", "claude md", "claude.md", "settings.json"],
    "シフト管理": ["シフト", "shift", "勤怠"],
    "OpenClaw": ["openclaw", "open claw"],
    "AI開発": ["ai ", "llm", "gemini", "gpt"],
    "Web開発": ["next.js", "react", "typescript", "tailwind", "web"],
    "美容室・店舗": ["美容室", "美容院", "サロン", "店舗", "ホームページ"]
  }
}
```

未分類の高 imp クエリは「その他」クラスタに集約（imp ≥ `unclustered_min_impressions`、デフォルト 20）。

## Cluster Suggestions ロジック

未分類クエリから新クラスタ候補を自動提案するアルゴリズム:

1. **フィルタ**: impressions ≥ `cluster_suggestion_min_impressions`（デフォルト 50）の未分類クエリを抽出
2. **トークン分割**: 空白・ハイフン・アンダースコアで分割
3. **ストップワード除外**: 日英の助詞・冠詞・一般的な機能語を除外（1文字トークンも除外）
4. **グループ化**: 共通トークンごとにクエリをグループ化（2件以上で候補）
5. **ソート**: `total_impressions` 降順
6. **重複除去**: 上位グループに含まれるクエリは下位から除外
7. **出力**: 上位 `cluster_suggestion_top_n`（デフォルト 5）件

LLM はこの提案を確認し、有用なものを `seo-config.json` の `cluster_keywords` に手動追加する。

## Device Gap 判定

| Gap | 判定基準 | アクション |
| --- | -------- | ---------- |
| severe | mobile_bounce_gap > 15pt | Core Web Vitals 測定 + モバイル UX 改善 |
| moderate | mobile_bounce_gap 5-15pt | モバイル CTA 配置確認 |
| acceptable | mobile_bounce_gap < 5pt | 維持 |

## KPI Target 設定ガイドライン

3ヶ月目標の目安:

| Metric | 改善目安 | Driver |
| ------ | -------- | ------ |
| GSC clicks | +50-100% | 既存記事最適化 + 新規記事 |
| GSC avg CTR | +1-2pt | タイトル/メタ改善 |
| GA4 pages/session | +0.3-0.5 | 内部リンク + CTA |
| GA4 engagement rate | +5-10pt | コンテンツ改善 |
| Mobile bounce rate | -10-15pt | モバイル最適化 |
