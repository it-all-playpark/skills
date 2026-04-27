# SEO Strategy Agent Team - Lifecycle

## Team Composition

| Agent Name | Type | Role | 担当セクション |
|---|---|---|---|
| `seo-lead` | orchestrator (self) | チーム統括・統合・最終出力 | metadata, kpi_snapshot, kpi_targets, roadmap |
| `measure-evaluator` | Explore | 施策効果評価・計測有効性検証・テーマ×CV分析 | measure_evaluation, data_validity, theme_cv_analysis |
| `content-strategist` | Explore | コンテンツ戦略・記事改善・クラスタ設計 | existing_article_optimizations, new_article_directions, cluster_suggestions |
| `tech-seo-specialist` | Explore | 技術SEO・サイト構造・コードベース監査 | technical_seo, site_structure, codebase_audit |
| `channel-kpi-analyst` | Explore | チャネル分析・KW競合性・ドメイン権威性 | channel_strategy, category_performance, domain_authority_map |

**悪魔の代弁者**: 独立したレビューフェーズとして `seo-lead` が実行（`references/devils-advocate.md` のチェックリストに基づくレビューループ）。

## Phase Overview

```
Phase 1: Setup        → TeamCreate + データ配布
Phase 2: Parallel     → 4専門家が並列分析 + クロスドメイン問い合わせ
Phase 3: Synthesize   → seo-lead が統合・roadmap 生成
Phase 4: Devil's Adv  → 建設的批判ループ（max 2 rounds）
Phase 5: Finalize     → 最終修正 + JSON/MD 出力
Phase 6: Shutdown     → チーム解散
```

## Phase 1: Setup

1. **TeamCreate**: チーム `seo-strategy-team` を作成
2. **Agent 起動**: 4専門家を Agent ツールで起動（`team_name: "seo-strategy-team"`）
3. **データ配布**: 各エージェントに以下を SendMessage で送信:
   - `seo-strategy-analysis.json` のパス
   - 既存 `seo-strategy.json` のステータスマッピング（該当セクションのみ）
   - `references/analysis_guide.md` の該当閾値・判断基準

### Agent 起動プロンプト

**measure-evaluator**:
```
あなたは施策効果測定の専門家です。以下の手順で既存施策の効果を評価してください:

1. git log からアナリティクス・CTA・内部リンク関連のコミットを検索し、施策デプロイ日を特定
2. 多期間GA4データ（30d, prev30d, 7d, prev7d）を読み込み、デプロイ日を境界に期間分割
3. 日次正規化で施策前後の指標を比較（sessions/day, PV/session, event rates）
4. コードベースを走査し、既に実装済みの施策（CTA、関連記事、内部リンク等）をリストアップ
5. (not set) LP のノイズ比率を算出し、実質 PV/Session を計算
6. Landing Page をテーマ分類し、テーマ別CVRを算出

出力セクション:
1. measure_evaluation（施策タイムライン、期間比較、実装済み一覧）
2. data_validity（イベント計測開始日、ノイズ分析、断言の信頼度）
3. theme_cv_analysis（テーマ別CVR、ブログ vs 非ブログ、CV発生ページ）

判断基準は references/analysis_guide.md の「施策効果評価フレームワーク」「ノイズ分離ガイドライン」「テーマ×CV相関分析」に従う。

🔴 CRITICAL:
- イベント追加日以前のデータで「イベント数0」は「未計測」であり「未発生」ではない
- CV数 < 20 の場合、CVRの前後比較は避け絶対数のみ報告
- 施策と計測開始が同日の場合、前後比較のconfidenceはlowとする
```

**content-strategist**:
```
あなたはコンテンツ戦略の専門家です。以下のデータを分析し、戦略提案を生成してください:
- article_metrics: 記事別メトリクス・issues
- query_clusters: クエリクラスタ
- cluster_suggestions: 新クラスタ提案
- trends_summary: トレンドデータ
- content_overlap_analysis: KW × 既存記事の重複マップ（**新規提案前に必ず参照**）

出力セクション:
1. existing_article_optimizations（references/schema.md 準拠）
2. new_article_directions（ファネルステージ明示）
3. cluster_suggestions の評価・追加提案

measure-evaluator の結果を必ず参照し:
- 既に実装済みの施策は提案から除外する
- data_validity.assertions で confidence: low の指標に基づく提案には注意書きを付ける
- theme_cv_analysis の diagnosis を new_article_directions の funnel 判定に活用する

🔴 CRITICAL (新規記事提案ガード - Issue #69):
- new_article_directions に書く前に必ず `content_overlap_analysis.clusters[].coverage_count` を確認する
- `coverage_count >= 3` のクラスタには新規提案禁止（existing_article_optimizations を優先）
- `coverage_count >= 2` でも `priority: high` は付けない
- `existing_articles` だけでは GSC 未反映の新着記事を見落とすため、
  必ず `content_overlap_analysis.coverage_articles` (frontmatter ベース機械判定) を参照する

判断基準は references/analysis_guide.md に従う。
tech-seo-specialist や channel-kpi-analyst に質問がある場合は SendMessage で問い合わせること。
```

**tech-seo-specialist**:
```
あなたは技術SEOの専門家です。以下のデータを分析し、戦略提案を生成してください:
- codebase_audit: コードベース技術SEO監査結果
- device_gap_analysis: モバイル/デスクトップギャップ
- article_metrics: 記事別メトリクス（内部リンク観点）

出力セクション:
1. technical_seo（モバイル、CV追跡、構造化データ、画像最適化）
2. site_structure（内部リンク戦略、CTA設計）

codebase_audit の severity を考慮して優先度付けすること。
content-strategist に内部リンク対象記事について問い合わせること。
```

**channel-kpi-analyst**:
```
あなたはデジタルマーケティング分析の専門家です。以下のデータを分析してください:
- channel_metrics: チャネル別メトリクス
- category_performance: カテゴリ別パフォーマンス
- domain_authority_map: KW領域別権威性
- kpi_snapshot（GA4/GSC）

出力セクション:
1. channel_strategy（チャネル別改善アクション）
2. category_performance の診断・改善提案
3. domain_authority_map の強み/弱み分析
4. keyword_competitiveness 評価

他の専門家にチャネル×コンテンツの相関について問い合わせ可能。
```

## Phase 2: Parallel Analysis

**ターン予算**: 各専門家 最大 8 ターン

**並列実行**: 4専門家が同時に分析を開始

**クロスドメイン問い合わせ**: 分析中に他専門家への質問が必要な場合、SendMessage で問い合わせる（`references/cross-domain-patterns.md` 参照）

**完了条件**: 各専門家が担当セクションの JSON を SendMessage で seo-lead に送信

**アイドル管理**: 専門家がアイドル状態になるのは正常。SendMessage で作業を送ると復帰する。

## Phase 3: Synthesize

`seo-lead` が実行:

1. 4専門家からの出力を収集
2. 重複・矛盾を検出して解消
3. 既存ステータスをマッピング（slug/type/channel キー）
4. `measure_evaluation.implemented_measures` を参照し、他専門家が提案した施策のうち実装済みのものを `done` ステータスに変更
5. `data_validity.assertions` の confidence: low を全セクションの該当主張に反映
6. `kpi_targets` を算出（analysis_guide.md の目安に基づく）
7. `roadmap` を生成（全セクションの priority × codebase_audit severity を考慮）
8. 統合 JSON ドラフトを組み立て

## Phase 4: Devil's Advocate Review

`seo-lead` が `references/devils-advocate.md` のチェックリストに基づいてレビュー:

1. 統合ドラフトに対して悪魔の代弁者チェックを実行
2. `blocking` / `non-blocking` に分類
3. blocking 項目があれば修正 → 再チェック
4. **最大 2 ラウンド**（blocking 0 件で早期終了）
5. 残存 non-blocking は `seo-strategy.md` の末尾に「留意事項」として記載

## Phase 5: Finalize

1. `claudedocs/seo-strategy.json` を出力（schema.md 準拠）
2. `claudedocs/seo-strategy.md` を出力（report_template.md 準拠 + 悪魔の代弁者セクション追加）
3. 悪魔の代弁者レビュー結果を Plan Quality Gate として記載

## Phase 6: Shutdown

1. 各専門家に SendMessage (`type: "shutdown_request"`) を送信
2. shutdown_response を受信確認
3. TeamDelete でチーム解散

## Turn Budget

**合計上限**: 46 ターン

| Agent | 割り当て | 用途 |
|---|---|---|
| seo-lead | ~14 ターン | Setup(2) + Synthesize(4) + Devil's Advocate(4x2) + Finalize(2) + Shutdown(2) |
| measure-evaluator | ~8 ターン | git log分析・多期間比較・ノイズ分離・テーマ×CV |
| content-strategist | ~8 ターン | 記事分析・クラスタ評価・方向性提案 |
| tech-seo-specialist | ~8 ターン | コードベース監査評価・サイト構造分析 |
| channel-kpi-analyst | ~8 ターン | チャネル分析・権威性評価・KPI分析 |

**早期終了トリガー**:
- 専門家が 3 ターン連続で新規発見なし → 完了扱い
- ターン予算超過 → 現在の出力で続行

## Error Recovery

| Error | Action |
|---|---|
| 専門家が応答しない | 2回リトライ → seo-lead が該当セクションを自力で生成 |
| クロスドメイン問い合わせタイムアウト | 問い合わせなしで続行、統合時に seo-lead が補完 |
| TeamCreate 失敗 | Agent Team なしのフォールバック（従来の単一LLM方式） |
| 悪魔の代弁者で blocking が解消されない | 2ラウンド後、blocking 理由を seo-strategy.md に記載して出力 |
