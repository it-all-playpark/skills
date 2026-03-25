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
| `zero_impressions` | 公開30日+ & imp = 0 | KW不適合 or ドメイン権威性不足 |

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

## Category Performance 分析（LLM用）

### zero_impressions issue の意味

公開から30日以上経過しているにもかかわらず GSC impressions が 0 の記事。KW が検索需要に合っていない、またはドメイン権威性が不足している可能性がある。

### zero_impression_rate による診断

| zero_impression_rate | 診断 | 推奨アクション |
|---------------------|------|-------------|
| 0-20% | 正常 | 個別記事の改善で対応 |
| 20-50% | KW戦略に問題あり | KWリターゲットを推奨 |
| 50%+ | ドメイン権威性が不足 | KW領域自体の見直しが必要 |

### カテゴリ間格差の検知

tech-tips/lab-reports の avg_impressions と solutions/case-studies の avg_impressions を比較:
- 10倍以上の差 → ビジネスKW領域でのドメイン権威性不足を指摘
- 報告時に domain_authority_map と合わせて「勝てている領域」「勝てていない領域」を明示

### KW競合性の推定（domain_authority_map ベース）

| strength | 意味 | 新記事への示唆 |
|---------|------|-------------|
| strong | CTR 5%+ & clicks 20+ | この領域の新記事は有望 |
| moderate | imp 100+ だが clicks 少 | title/meta 改善で伸びる余地 |
| weak | imp 少 or CTR 低 | この領域のKWは競合が強い可能性。新記事は慎重に |

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

## 施策効果評価フレームワーク（measure-evaluator 用）

### 施策タイムライン構築

git log から以下のカテゴリの施策デプロイ日を特定:

| カテゴリ | grep パターン | 例 |
|---|---|---|
| アナリティクスイベント | `analytics`, `tracking`, `event`, `scroll_depth`, `cta_click` | scroll_depth_90 追加日 |
| CTA コンポーネント | `cta`, `CTA`, `banner`, `consultation` | BlogCTABanner 追加日 |
| 内部リンク | `internal.link`, `related`, `inline.*card`, `series.*nav` | InlineRelatedCard 追加日 |
| SEO構造 | `hub`, `cluster`, `sitemap`, `jsonld`, `structured` | ハブページ追加日 |

### 期間分割ルール

施策のデプロイ日を境界にしてGA4データを分割し、日次正規化で比較:

```
期間A（施策前）: デプロイ日の前の期間
期間B（施策後）: デプロイ日から現在まで
```

**日次正規化**: 期間の長さが異なるため、全指標を「/日」で正規化して比較する。
絶対数（sessions, PV）は日次平均、率（bounce rate, engagement rate）はセッション加重平均で算出。

### イベントデータの有効期間判定

| 条件 | 判定 | アクション |
|---|---|---|
| イベント追加日から 7日未満 | **評価不能** | 「データ不足のため断言不可」と明記 |
| イベント追加日から 7-14日 | **参考値** | 「暫定的な傾向」として扱う |
| イベント追加日から 14日以上 | **有効** | 通常の分析対象 |

🔴 **CRITICAL**: イベント追加日以前のデータでイベント数が0の場合、「イベントが発生しなかった」ではなく「計測されていなかった」と解釈すること。

### 施策効果の判定基準

| 指標変化 | 判定 | 備考 |
|---|---|---|
| 日次正規化で +10% 以上 | 効果あり（要確認） | 他の変数の影響を排除できているか |
| 日次正規化で ±10% 以内 | 効果なし or 微小 | |
| 日次正規化で -10% 以下 | 悪化（要調査） | |
| CV系で絶対数 < 20 | **統計的に不十分** | CVRの比較は避け、絶対数の推移のみ報告 |

### 既存実装チェック

提案を生成する前に、コードベースで以下を確認:

1. `components/blog/` 配下の CTA・関連記事コンポーネントの有無
2. `lib/` 配下の内部リンク・シリーズナビ・ハブの実装有無
3. `app/blog/[slug]/page.tsx` のレイアウト構成（何がどの順で配置されているか）

**既に実装済みの施策は `done` ステータスで出力し、新規提案からは除外する。**

## ノイズ分離ガイドライン

### (not set) Landing Page の扱い

GA4 で `landingPage` が `(not set)` または空文字のセッションは以下の原因で発生:

| 原因 | 特徴 | 対処 |
|---|---|---|
| Bot/クローラー | bounce 90%+, dur < 30s, 国 (not set) | 分析時に除外 |
| ブラウザ Prefetch | page_view なしで session_start | 分析時に除外 |
| SPA遷移欠損 | Next.js client-side routing | 技術的修正を提案 |

### 実質 PV/Session の算出

```
実質 PV/Session = 全体 PV / (全体 sessions - (not set) LP sessions)
```

レポートには「全体 PV/Session」と「実質 PV/Session（not set 除外）」を**併記**すること。

### ノイズ比率の警告

| (not set) 比率 | 判定 |
|---|---|
| < 5% | 正常（無視可能） |
| 5-15% | 注意（分析時に除外を推奨） |
| > 15% | 異常（技術的原因の調査を推奨） |

## テーマ × CV 相関分析

### ランディングページの分類

各 Landing Page をコンテンツテーマで分類し、テーマ別に CVR を算出:

| テーマ分類 | URL パターン例 |
|---|---|
| ツール比較・選定 | `comparison`, `vs-`, `pricing`, `complete-guide` |
| 技術 How-to | `skills-`, `hooks-`, `customization`, `worktree-` |
| ソリューション/事例 | `shift-bud`, `salon-`, `site-renewal-` |
| サービスページ | `/`, `/contact`, `/about`, `/solutions/` |

### 分析出力

テーマ別に以下を算出し、**読者層とCVターゲットのミスマッチ**を検知:

```json
{
  "theme": "ツール比較・選定",
  "sessions": 4164,
  "conversions": 4,
  "cvr": 0.10,
  "engagement_rate": 77,
  "avg_duration": 287,
  "diagnosis": "高エンゲージメントだがCV低い → 読者は情報収集目的の開発者が中心"
}
```

### ミスマッチ検知ルール

| 条件 | 診断 |
|---|---|
| エンゲージメント率 60%+ かつ CVR < 0.5% | **読者≠CVターゲット**: コンテンツは良質だが、読者層がCV対象外 |
| CVR > 1% かつ sessions < 100 | **CVポテンシャル高**: このテーマの記事を増産すべき |
| エンゲージメント率 < 40% かつ CVR < 0.5% | **コンテンツ品質問題**: リライト or 削除検討 |
| ブログ全体CVR と 非ブログCVR の差が 10倍以上 | **構造的ミスマッチ**: ブログ→CVの導線設計を根本的に見直す |
