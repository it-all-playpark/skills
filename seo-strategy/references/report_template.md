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

## 2. 既存記事改善アクション

{existing_article_optimizations を priority 順に記述}

### {priority}: {slug} `{status}`

- **現状**: imp {metrics.impressions} / CTR {metrics.ctr}% / 直帰率 {metrics.bounce_rate}%
- **課題**: {actions[].rationale の要約}
- **アクション**:
  - {action.status == "done" ? "[x]" : "[ ]"} {action.type}: {action.suggestion}
  - ...
- **期待効果**: {expected_impact}

---

## 3. サイト構造改善

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

## 4. 技術 SEO 課題

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

## 5. チャネル戦略

{channel_strategy を priority 順に記述}

| チャネル | 優先度 | Status | 課題 | セッション数 | 直帰率 | アクション |
| -------- | ------ | ------ | ---- | ------------ | ------ | ---------- |
| {channel} | {priority} | {status} | {issue} | {metrics.sessions} | {metrics.bounce_rate}% | {actions のカンマ区切り} |

---

## 6. 新規記事方向性

{new_article_directions を priority 順に記述}

### {keyword_area} ({priority} / {funnel})

- **根拠**: {evidence}
- **切り口案**:
  - {suggested_angles[0]}
  - {suggested_angles[1]}

---

## 7. クラスタ提案

{cluster_suggestions がある場合に記述。未分類クエリから自動検出された新クラスタ候補。}

| 提案キーワード | クエリ数 | 合計 imp | 合計 clicks | 含まれるクエリ（抜粋） |
| -------------- | -------- | -------- | ----------- | ---------------------- |
| {suggested_keyword} | {query_count} | {total_impressions} | {total_clicks} | {queries[:3] のカンマ区切り} |

> これらの提案が有用な場合、`seo-config.json` の `cluster_keywords` に追加してください。

---

## 8. ドメイン権威性分析

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

## 9. ロードマップ

{roadmap.phases を記述}

### Phase {phase}: {name}（{timeframe}）

**フォーカス**: {focus}

- [ ] {actions[0]}
- [ ] {actions[1]}
- [ ] ...

---

_次回更新: {generated_at + 30日}_
```

## セクション別記述ガイドライン

### 8. ドメイン権威性分析

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

### 2. 既存記事改善アクション

- `existing_article_optimizations` の各エントリを展開
- priority: high → medium → low の順で記述
- チェックボックス形式で実行可能なアクション一覧を提示
- `expected_impact` は定量的に記述（例: 「CTR 2.8% → 5%+ で月 +30 clicks」）

### 3. サイト構造改善

- 内部リンクと CTA を分けて記述
- 具体的な記事 slug を列挙し、実装イメージを明確にする
- ピラーページ提案がある場合は、ハブ/スポーク構造を図示

### 4. 技術 SEO 課題

- テーブル形式で現在値・目標値・アクションを一覧化
- CV トラッキング未設定の場合は **critical** として強調
- 実装手順は含めず、課題とアクション名のみ記述

### 5. チャネル戦略

- テーブル形式でチャネル横断比較
- 直帰率 100% 等の異常値は **太字** で強調
- 良好なチャネル（qiita等）も「維持」として記載

### 6. 新規記事方向性

- `new_article_directions` の各エントリを展開
- ファネルステージを明示（認知/興味/検討/行動）
- 切り口案は seo-content-planner の `--strategy` 入力として活用される旨を注記

### 7. クラスタ提案

- `cluster_suggestions` の各エントリをテーブル形式で記述
- 提案が空の場合はセクションごと省略
- 有用な提案を `seo-config.json` に追加するよう促す注記を含める

### 8. ロードマップ

- フェーズごとにチェックボックス形式
- 時系列を明確にし、依存関係がある場合は注記
- 次回更新日を明記（generated_at + TTL 30日）

## SKILL.md Output セクションとの対応

| SKILL.md セクション | レポートセクション | 情報ソース |
| -------------------- | ------------------ | ---------- |
| エグゼクティブサマリー（KPI + 3つの重要発見） | 1. エグゼクティブサマリー | `kpi_snapshot` + `kpi_targets` + LLM判断 |
| 既存記事改善アクション（優先度順） | 2. 既存記事改善アクション | `existing_article_optimizations` |
| サイト構造改善 | 3. サイト構造改善 | `site_structure` |
| 技術SEO課題 | 4. 技術 SEO 課題 | `technical_seo` |
| チャネル戦略 | 5. チャネル戦略 | `channel_strategy` |
| 新規記事方向性 | 6. 新規記事方向性 | `new_article_directions` |
| クラスタ提案 | 7. クラスタ提案 | `cluster_suggestions` |
| ドメイン権威性分析 | 8. ドメイン権威性分析 | `category_performance` + `domain_authority_map` |
| ロードマップ | 9. ロードマップ | `roadmap` |

## 注意事項

- レポートは `seo-strategy.json` の **すべてのセクション** を網羅すること
- 数値は JSON から直接引用し、LLM が加工・丸めを行わない
- `ga4-gsc-strategy-*.md` を置き換える位置づけであり、同等以上の情報密度を確保する
- レポート末尾に次回更新日（TTL 30日）を明記する
