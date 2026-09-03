# seo-strategy.md レポートテンプレート

`/seo-strategy` 実行時に `claudedocs/seo-strategy.md` として生成する人間向けレポートのテンプレート。
`claudedocs/seo-strategy.json` の構造化データを元に、各セクションを記述する。

## テンプレート構成

```markdown
# SEO 戦略レポート — {site}

> 生成日: {metadata.generated_at}
> 対象期間: {metadata.period}
> データソース: GA4, GSC, Google Trends

---

## 1. エグゼクティブサマリー

### 現在の KPI

| 指標 | 現在値 | 目標値 |
| ---- | ------ | ------ |
| GSC クリック数/月 | {kpi_snapshot.gsc.clicks} | {kpi_targets.targets[gsc_clicks_monthly].target} |
| GSC 平均 CTR | {kpi_snapshot.gsc.avg_ctr}% | {kpi_targets.targets[gsc_avg_ctr].target}% |
| GSC 平均掲載順位 | {kpi_snapshot.gsc.avg_position} | — |
| GA4 アクティブユーザー | {kpi_snapshot.ga4.active_users} | — |
| GA4 直帰率 | {kpi_snapshot.ga4.bounce_rate}% | — |
| Pages/Session | {kpi_snapshot.ga4.pages_per_session} | {kpi_targets.targets[ga4_pages_per_session].target} |
| エンゲージメント率 | {kpi_snapshot.ga4.engagement_rate}% | {kpi_targets.targets[ga4_engagement_rate].target}% |

### 3 つの重要発見

1. **{発見1タイトル}**: {根拠データを含む1-2文の説明}
2. **{発見2タイトル}**: {根拠データを含む1-2文の説明}
3. **{発見3タイトル}**: {根拠データを含む1-2文の説明}

---

## 2. 施策効果評価

> 戦略提案の前に、既に実施済みの施策の効果を検証する。

### 施策タイムライン

| 日付 | 施策 | カテゴリ | 影響指標 |
| ---- | ---- | -------- | -------- |
| {deployment_timeline[].date} | {description} | {category} | {affected_metrics} |

### 期間比較

{measure_evaluation.period_comparisons を展開}

#### {name}

| 指標 | 施策前 ({period_a.label}) | 施策後 ({period_b.label}) | 変化率 |
| ---- | ------------------------ | ------------------------ | ------ |
| {metric} | {before} | {after} | {change_pct}% |

**判定**: {verdict}（確度: {confidence}）
**根拠**: {rationale}

### 実装済み施策一覧

| カテゴリ | コンポーネント | ステータス | 備考 |
| -------- | -------------- | ---------- | ---- |
| {category} | {component} | {status} | {note} |

> ⚠️ 以降のセクションで提案される施策は、上記の実装済み施策と重複しない。

---

## 3. 計測データの信頼性

### イベント計測開始日

| イベント | 計測開始日 | 経過日数 | データ有効性 |
| -------- | ---------- | -------- | ------------ |
| {event} | {date} | {days_since} | {有効 / 参考値 / 評価不能} |

### ノイズ分析

- **(not set) LP**: {noise_analysis.not_set_lp_sessions} sessions ({not_set_lp_pct}%)、bounce {not_set_lp_bounce}%
- **全体 PV/Session**: {raw_pv_per_session} → **(not set) 除外後**: {adjusted_pv_per_session}
- **判定**: {severity}

### 断言の信頼度

| 主張 | 確度 | 根拠 |
| ---- | ---- | ---- |
| {claim} | {confidence} | {basis} |

> confidence: low の主張は暫定値として扱い、追加データ収集後に再評価すること。

---

## 4. テーマ × CV 相関分析

### テーマ別 CVR

| テーマ | Sessions | CV | CVR | Engagement | 診断 |
| ------ | -------- | -- | --- | ---------- | ---- |
| {theme} | {sessions} | {conversions} | {cvr}% | {engagement_rate}% | {diagnosis} |

### ブログ vs 非ブログ

| 区分 | Sessions | CV | CVR |
| ---- | -------- | -- | --- |
| ブログ記事 | {blog_sessions} | {blog_cv} | {blog_cvr}% |
| 非ブログ | {non_blog_sessions} | {non_blog_cv} | {non_blog_cvr}% |
| **ミスマッチ倍率** | — | — | **{mismatch_ratio}x** |

### CVが発生したページ

| ページ | Sessions | CV | CVR | テーマ |
| ------ | -------- | -- | --- | ------ |
| {page} | {sessions} | {cv} | {cvr}% | {theme} |

### 戦略的示唆

{theme_cv_analysis.strategic_implication}

---

## 5. 既存記事改善アクション

{existing_article_optimizations を priority 順に記述}

### {priority}: {slug} `{status}`

- **現状**: imp {metrics.impressions} / CTR {metrics.ctr}% / 直帰率 {metrics.bounce_rate}%
- **課題**: {actions[].rationale の要約}
- **アクション**:
  - {action.status == "done" ? "[x]" : "[ ]"} {action.type}: {action.suggestion}
  - ...
- **期待効果**: {expected_impact}

---

## 6. サイト構造改善

### 内部リンク戦略

{site_structure.internal_linking を priority 順に記述}

- **{type}**: {description}
  - 対象記事: {articles のリスト}
  - 根拠: {rationale}
  - 期待効果: {expected_impact}

### CTA 戦略

{site_structure.cta_strategy を記述}

- **{type}**: {description}
  - 遷移先: {target_page}
  - 根拠: {rationale}
  - 期待効果: {expected_impact}

---

## 7. 技術 SEO 課題

### モバイル最適化

{technical_seo.mobile.issues を記述}

| 指標 | 現在値 | 目標値 | アクション |
| ---- | ------ | ------ | ---------- |
| {metric} | {current} | {target} | {actions のカンマ区切り} |

### CV トラッキング

- 設定状態: {technical_seo.conversion_tracking.configured ? "設定済み" : "未設定"}
- 必要イベント:
  - {required_events[].event}: {description}
- 根拠: {rationale}

---

## 8. チャネル戦略

{channel_strategy を priority 順に記述}

| チャネル | 優先度 | Status | 課題 | セッション数 | 直帰率 | アクション |
| -------- | ------ | ------ | ---- | ------------ | ------ | ---------- |
| {channel} | {priority} | {status} | {issue} | {metrics.sessions} | {metrics.bounce_rate}% | {actions のカンマ区切り} |

---

## 9. 新規記事方向性

{new_article_directions を priority 順に記述}

### {keyword_area} ({priority} / {funnel})

- **根拠**: {evidence}
- **切り口案**:
  - {suggested_angles[0]}
  - {suggested_angles[1]}

---

## 10. クラスタ提案

{cluster_suggestions がある場合に記述。未分類クエリから自動検出された新クラスタ候補。}

| 提案キーワード | クエリ数 | 合計 imp | 合計 clicks | 含まれるクエリ（抜粋） |
| -------------- | -------- | -------- | ----------- | ---------------------- |
| {suggested_keyword} | {query_count} | {total_impressions} | {total_clicks} | {queries[:3] のカンマ区切り} |

> これらの提案が有用な場合、`seo-config.json` の `cluster_keywords` に追加してください。

---

## 11. ドメイン権威性分析

{category_performance と domain_authority_map から生成}

### カテゴリ別パフォーマンス

| カテゴリ | 記事数 | 総imp | 平均imp | imp0率 |
| -------- | ------ | ----- | ------- | ------ |
| {category} | {article_count} | {total_impressions} | {avg_impressions} | {zero_impression_rate}% |

### 強み領域 / 弱み領域

{domain_authority_map を strength 順に記述}

| KW領域 | 強度 | imp | CTR | 示唆 |
| ------ | ---- | --- | --- | ---- |
| {area} | {strength} | {impressions} | {ctr}% | {LLMが strength に応じた示唆を記述} |

### KW戦略への示唆

- {LLMが category_performance + domain_authority_map から導出した戦略的示唆}
- imp0率が高いカテゴリは KW 領域の見直しを検討
- strong 領域の深堀り、weak 領域の撤退/リターゲットを判断

---

## 12. ロードマップ

{roadmap.phases を記述}

### Phase {phase}: {name}（{timeframe}）

**フォーカス**: {focus}

- [ ] {actions[0]}
- [ ] {actions[1]}
- [ ] ...

---

## 13. Plan Quality Gate

> Devil's advocate review rounds: {N}
> Blocking findings resolved: {yes/no}

### Review Summary

| Dimension | Result | Notes |
|---|---|---|
| データ根拠の妥当性 | {pass/blocking/non-blocking} | {notes} |
| 優先度の一貫性 | {pass/blocking/non-blocking} | {notes} |
| 実行可能性 | {pass/blocking/non-blocking} | {notes} |
| 機会コストとトレードオフ | {pass/blocking/non-blocking} | {notes} |
| KPI 目標の現実性 | {pass/blocking/non-blocking} | {notes} |
| 内部整合性 | {pass/blocking/non-blocking} | {notes} |
| 見落としチェック | {pass/blocking/non-blocking} | {notes} |

### 留意事項（Non-blocking）

{non-blocking 項目がある場合のみ記述}

- {concern}: {rationale}

---

_次回更新: {generated_at + 30日}_
```

## セクション別記述ガイドライン

### 11. ドメイン権威性分析

- `category_performance` からカテゴリ間の imp 格差を可視化
- `domain_authority_map` から強み/弱み領域を分類
- `zero_impression_rate` が高いカテゴリは KW 戦略の問題を指摘
- 数値は JSON から直接引用し、LLM は戦略的示唆のみを付加する

### 1. エグゼクティブサマリー

- KPI テーブルは `kpi_snapshot` と `kpi_targets` から直接マッピング
- 「3つの重要発見」は以下の観点から選定:
  - **最大のインパクト**: CTR改善で最もクリック増が見込める施策
  - **最大のリスク**: 放置すると悪化する課題（例: モバイル直帰率）
  - **最大の機会**: 未開拓だが高ポテンシャルな領域
- 各発見には必ず **具体的な数値** を含める

### 2. 施策効果評価

- `measure_evaluation` の全データを展開
- period_comparisons は verdict に応じた色分け表示（effective=太字、ineffective=打ち消し線）
- 実装済み施策は必ず全件リストアップ。以降のセクションでの重複提案を明示的に防止
- confidence: low の比較結果には「⚠️ 暫定値」を付記

### 3. 計測データの信頼性

- `data_validity` の全データを展開
- イベント経過日数は生成日から自動計算
- ノイズ分析は (not set) 除外前後の PV/Session を併記
- 断言テーブルの confidence: low 行は **太字** で強調

### 4. テーマ × CV 相関分析

- `theme_cv_analysis` の全データを展開
- diagnosis ごとに推奨アクションを付記:
  - reader_cv_mismatch → 「導入検討層向け記事の拡充を検討」
  - cv_potential → 「このテーマの記事増産を推奨」
  - content_quality_issue → 「リライトまたは統合を検討」
- blog_vs_non_blog のミスマッチ倍率が 10x 以上の場合、**構造的課題** として強調
- strategic_implication はそのまま引用（LLM による加工なし）

### 5. 既存記事改善アクション

- `existing_article_optimizations` の各エントリを展開
- priority: high → medium → low の順で記述
- チェックボックス形式で実行可能なアクション一覧を提示
- `expected_impact` は定量的に記述（例: 「CTR 2.8% → 5%+ で月 +30 clicks」）

### 6. サイト構造改善

- 内部リンクと CTA を分けて記述
- 具体的な記事 slug を列挙し、実装イメージを明確にする
- ピラーページ提案がある場合は、ハブ/スポーク構造を図示

### 7. 技術 SEO 課題

- テーブル形式で現在値・目標値・アクションを一覧化
- CV トラッキング未設定の場合は **critical** として強調
- 実装手順は含めず、課題とアクション名のみ記述

### 8. チャネル戦略

- テーブル形式でチャネル横断比較
- 直帰率 100% 等の異常値は **太字** で強調
- 良好なチャネル（qiita等）も「維持」として記載

### 9. 新規記事方向性

- `new_article_directions` の各エントリを展開
- ファネルステージを明示（認知/興味/検討/行動）
- 切り口案は seo-content-planner の `--strategy` 入力として活用される旨を注記

### 10. クラスタ提案

- `cluster_suggestions` の各エントリをテーブル形式で記述
- 提案が空の場合はセクションごと省略
- 有用な提案を `seo-config.json` に追加するよう促す注記を含める

### 12. ロードマップ

- フェーズごとにチェックボックス形式
- 時系列を明確にし、依存関係がある場合は注記
- 次回更新日を明記（generated_at + TTL 30日）

## SKILL.md Output セクションとの対応

| SKILL.md セクション | レポートセクション | 情報ソース |
| -------------------- | ------------------ | ---------- |
| エグゼクティブサマリー（KPI + 3つの重要発見） | 1. エグゼクティブサマリー | `kpi_snapshot` + `kpi_targets` + LLM判断 |
| 施策効果評価 | 2. 施策効果評価 | `measure_evaluation` |
| 計測データの信頼性 | 3. 計測データの信頼性 | `data_validity` |
| テーマ×CV相関分析 | 4. テーマ×CV相関分析 | `theme_cv_analysis` |
| 既存記事改善アクション（優先度順） | 5. 既存記事改善アクション | `existing_article_optimizations` |
| サイト構造改善 | 6. サイト構造改善 | `site_structure` |
| 技術SEO課題 | 7. 技術 SEO 課題 | `technical_seo` |
| チャネル戦略 | 8. チャネル戦略 | `channel_strategy` |
| 新規記事方向性 | 9. 新規記事方向性 | `new_article_directions` |
| クラスタ提案 | 10. クラスタ提案 | `cluster_suggestions` |
| ドメイン権威性分析 | 11. ドメイン権威性分析 | `category_performance` + `domain_authority_map` |
| ロードマップ | 12. ロードマップ | `roadmap` |
| Plan Quality Gate | 13. Plan Quality Gate | Devil's advocate review results |

## 注意事項

- レポートは `seo-strategy.json` の **すべてのセクション** を網羅すること
- 数値は JSON から直接引用し、LLM が加工・丸めを行わない
- `ga4-gsc-strategy-*.md` を置き換える位置づけであり、同等以上の情報密度を確保する
- レポート末尾に次回更新日（TTL 30日）を明記する
