---
name: seo-strategy
description: |
  Agent Team による多角的 SEO 戦略生成。GA4 + GSC + Trends データを統合分析し、
  コンテンツ戦略・技術SEO・チャネル分析の3専門家が並列分析 → 悪魔の代弁者レビューを経て
  構造化 JSON + MD で出力。seo-content-planner の上流に位置する。
  Use when: (1) SEO全体戦略の策定・更新,
  (2) keywords: SEO戦略, サイト改善, CTR改善, 内部リンク, コンテンツ戦略,
  (3) blog-publish の --skip-seo なしフローの上流ステップとして。
  Accepts args: [--refresh] [--ga-report PATH] [--gsc-report PATH] [--trends-report PATH] [--config PATH]
---

# SEO Strategy (Agent Team)

GA4 + GSC + Trends を統合分析し、**3専門家の並列分析 + 悪魔の代弁者レビュー**を経て、サイト全体の SEO 戦略を `claudedocs/seo-strategy.json` + `claudedocs/seo-strategy.md` で出力する。

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

## Agent Team Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        seo-lead (self)                           │
│  統括・施策効果評価・統合・悪魔の代弁者・最終出力                │
└────────┬──────────────┬──────────────┬──────────────┬────────────┘
         │              │              │              │
┌────────▼───────┐ ┌───▼──────────┐ ┌▼──────────────┐ ┌▼───────────────┐
│  measure-      │ │  content-    │ │  tech-seo-    │ │  channel-kpi-  │
│  evaluator     │ │  strategist  │ │  specialist   │ │  analyst       │
│                │ │              │ │               │ │                │
│ 施策効果評価   │ │ 記事改善     │ │ 技術SEO       │ │ チャネル分析   │
│ 計測有効性検証 │ │ テーマ×CV    │ │ サイト構造    │ │ KW競合性      │
│ ノイズ分離     │ │ 新規記事方向 │ │ コードベース  │ │ ドメイン権威性 │
│ 多期間比較     │ │ クラスタ提案 │ │               │ │                │
└────────────────┘ └──────────────┘ └───────────────┘ └────────────────┘
         │              │              │              │
         └────────── SendMessage で相互問い合わせ ──────┘
```

詳細は `references/team-lifecycle.md` を参照。

## Workflow

1. **キャッシュ確認**: `claudedocs/seo-strategy.json` の `metadata.generated_at` を確認。TTL 30日以内なら既存を返す（`--refresh` でスキップ）
2. **データ収集**（`--refresh` 時、または元データ不足時）:
   - `/ga-analyzer` で GA4 データ取得
   - `/gsc` で GSC データ取得
   - `/trends-analyzer` で Trends データ取得
3. **多期間データ収集**: 施策効果評価のため、複数期間の GA4 データを取得
   - 直近30日 + 前30日（月次比較）
   - 直近7日 + 前7日（週次トレンド）
   - GA4レポートは4つ生成: `ga_30d.json`, `ga_prev30d.json`, `ga_7d.json`, `ga_prev7d.json`

4. **データ分析**: `scripts/strategy_analyzer.py` を実行
   ```bash
   python ~/.claude/skills/seo-strategy/scripts/strategy_analyzer.py \
     --ga-report <GA_PATH> --gsc-report <GSC_PATH> --trends-report <TRENDS_PATH> \
     --ga-prev-report <PREV_GA_PATH> \
     --config .claude/seo-config.json --blog-dir content/blog \
     --project-dir . --output claudedocs/seo-strategy-analysis.json
   ```

5. **施策タイムライン構築**: git log から施策デプロイ日を特定
   ```bash
   git log --oneline --since="<prev_period_start>" --all \
     --grep="feat\|fix" -- '**/analytics*' '**/cta*' '**/related*' '**/internal*link*'
   ```
   - 各カスタムイベント（scroll_depth_90, cta_click, internal_navigation 等）の追加日を特定
   - CTA コンポーネント、内部リンク、関連記事等の施策デプロイ日を記録

6. **ステータス引き継ぎ**: 既存 `seo-strategy.json` がある場合、各要素の `status` を slug/type/channel をキーにマッピングし、新しい戦略に引き継ぐ。新規要素は `"pending"` で初期化。

7. **Agent Team: 戦略生成** — 4専門家による並列分析 + 悪魔の代弁者レビュー:

   **Phase 1: Setup**
   - TeamCreate で `seo-strategy-team` を作成
   - 4専門家を Agent ツールで起動（`team_name: "seo-strategy-team"`）
   - 各専門家に `seo-strategy-analysis.json` パスとステータスマッピングを配布

   **Phase 2: Parallel Analysis** (各専門家 max 8 ターン)

   | Agent | 担当セクション | 入力データ |
   |---|---|---|
   | `measure-evaluator` | measure_evaluation, data_validity, theme_cv_analysis | 多期間GA4, git log, コードベース |
   | `content-strategist` | existing_article_optimizations, new_article_directions, cluster_suggestions | article_metrics, query_clusters, trends_summary, **measure_evaluation結果** |
   | `tech-seo-specialist` | technical_seo, site_structure | codebase_audit, device_gap_analysis, article_metrics |
   | `channel-kpi-analyst` | channel_strategy, category_performance, domain_authority_map | channel_metrics, category_performance, domain_authority_map |

   **重要**: `measure-evaluator` の結果は他3専門家に SendMessage で共有される。
   これにより「既に実装済みの施策を再提案」「計測期間不足のデータで断言」を防止する。

   専門家間は SendMessage でクロスドメイン問い合わせ可能（`references/cross-domain-patterns.md` 参照）

   **Phase 3: Synthesize**
   - seo-lead が4専門家の出力を統合
   - 重複・矛盾を解消
   - `measure_evaluation` の知見を全セクションに反映（既に実装済みの施策は `done` に）
   - `kpi_targets` と `roadmap` を生成

   **Phase 4: Devil's Advocate Review** (max 2 rounds)
   - `references/devils-advocate.md` のチェックリストで統合ドラフトをレビュー
   - blocking 項目を修正 → 再チェック
   - blocking = 0 または 2ラウンド完了で終了

   **Phase 5: Finalize**
   - `claudedocs/seo-strategy.json` 出力（schema は `references/schema.md`）
   - `claudedocs/seo-strategy.md` 出力 + Plan Quality Gate セクション

   **Phase 6: Shutdown**
   - 各専門家に shutdown_request → TeamDelete

6. **フォールバック**: TeamCreate 失敗時は従来の単一LLM方式で戦略生成を続行

## Skill Delegation

| Skill            | Purpose                    | When           |
| ---------------- | -------------------------- | -------------- |
| ga-analyzer      | GA4 データ取得             | `--refresh` 時 |
| gsc              | GSC データ取得             | `--refresh` 時 |
| trends-analyzer  | Trends データ取得          | `--refresh` 時 |

## References

| File | Purpose |
|---|---|
| `references/schema.md` | seo-strategy.json の構造化スキーマ |
| `references/report_template.md` | seo-strategy.md のレポート構成 |
| `references/analysis_guide.md` | 分析閾値・判断基準・Priority 判定ガイドライン |
| `references/team-lifecycle.md` | Agent Team のライフサイクル・ターン予算・エラー回復 |
| `references/cross-domain-patterns.md` | 専門家間 SendMessage テンプレート |
| `references/devils-advocate.md` | 悪魔の代弁者チェックリスト・ループプロトコル |

## Output: seo-strategy.json

構造化戦略 JSON。TTL 30日。詳細 schema は `references/schema.md` を参照。

主要セクション:
- `metadata` — 生成日時・期間・データソース・config パス
- `kpi_snapshot` — GSC/GA4 の現在KPI（多期間比較含む）
- `measure_evaluation` — **施策効果評価**（施策タイムライン、前後比較、効果判定）
- `data_validity` — **計測有効性**（イベント追加日、ノイズ分離、断言可否）
- `theme_cv_analysis` — **テーマ×CV相関分析**（読者層とCVターゲットのミスマッチ検知）
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
8. ドメイン権威性分析
9. ロードマップ
10. **Plan Quality Gate**（悪魔の代弁者レビュー結果）

## Error Handling

| Error                        | Action                                   |
| ---------------------------- | ---------------------------------------- |
| GA/GSC レポートなし           | `--refresh` を提案、または手動パス指定を案内 |
| strategy_analyzer.py 失敗     | stderr を確認し、入力ファイル形式を検証    |
| 既存 strategy.json が TTL 内  | 既存を返す旨を通知（`--refresh` で上書き可能） |
| config パスが無効             | デフォルト値にフォールバックして続行      |
| TeamCreate 失敗              | 従来の単一LLM方式にフォールバック        |
| 専門家が応答しない            | 2回リトライ → seo-lead が該当セクションを自力生成 |
| 悪魔の代弁者 blocking 未解消  | 2ラウンド後、blocking 理由を MD に記載して出力 |

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
