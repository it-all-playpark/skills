# Devil's Advocate Review - SEO Strategy

統合された SEO 戦略ドラフトに対する建設的批判フェーズ。
`seo-lead` が Phase 4 で実行し、戦略の品質を担保する。

## Purpose

- 専門家バイアスの検出（自分の領域を過大評価する傾向）
- 優先度の妥当性検証（本当に high か？）
- 見落としリスクの特定
- 内部矛盾の発見
- ROI 仮定への挑戦

## Review Dimensions

### 1. データ根拠の妥当性

- [ ] 各提案に定量的根拠（impressions, clicks, CTR, bounce_rate 等）が紐づいているか
- [ ] サンプルサイズが小さすぎる提案はないか（imp < 50 で high priority 等）
- [ ] トレンドデータの時期が古くないか（季節性の考慮）
- [ ] 相関を因果と誤認していないか

**Blocking**: 定量的根拠なしの high priority 提案

### 2. 優先度の一貫性

- [ ] priority: high の件数が多すぎないか（全体の 30% 以下が目安）
- [ ] セクション間で優先度基準が統一されているか
- [ ] roadmap のフェーズ割り当てが priority と整合しているか
- [ ] low priority 項目が roadmap Phase 1 に含まれていないか

**Blocking**: high priority が全体の 50% 超

### 3. 実行可能性

- [ ] 各アクションが具体的で実行可能か（「改善する」ではなく「タイトルを X に変更する」）
- [ ] roadmap の各フェーズの作業量が現実的か
- [ ] 依存関係が考慮されているか（例: 内部リンク追加前に orphan 記事の価値を検証）
- [ ] 技術的に不可能な提案はないか（既存アーキテクチャとの整合性）

**Blocking**: 実行不可能なアクションが roadmap Phase 1 に含まれている

### 4. 機会コストとトレードオフ

- [ ] リソース配分は最適か（既存改善 vs 新規記事のバランス）
- [ ] 短期成果（Quick Win）と長期投資が混在していないか
- [ ] 見送った代替案はないか（例: リライトより新規記事の方が ROI が高い可能性）
- [ ] 撤退判断は含まれているか（weak 領域からの撤退提案）

**Non-blocking**: 代替案の記載なし（留意事項として記載）

### 5. KPI 目標の現実性

- [ ] kpi_targets の改善幅が analysis_guide.md の目安範囲内か
- [ ] 目標達成に必要なアクション数と roadmap が整合しているか
- [ ] 外部要因（アルゴリズム変更、競合動向）のリスクが考慮されているか
- [ ] ベースラインが正確か（季節変動を除外した値か）

**Blocking**: KPI 目標が目安の 2 倍以上楽観的

### 6. 内部整合性

- [ ] existing_article_optimizations と new_article_directions で同じ KW 領域を重複カバーしていないか
- [ ] site_structure の内部リンク提案と existing_article_optimizations の対象記事が整合しているか
- [ ] technical_seo の修正提案が channel_strategy の改善と矛盾していないか
- [ ] cluster_suggestions が既存 cluster_keywords と重複していないか

**Blocking**: 明確な矛盾が存在

### 7. 見落としチェック

- [ ] codebase_audit の critical/high severity issue が roadmap に反映されているか
- [ ] zero_impression 記事への対策が含まれているか（放置 or 改善 or 削除）
- [ ] モバイル対応が device_gap の severity に見合っているか
- [ ] CV トラッキング未設定の場合、critical として扱われているか

**Blocking**: critical severity issue が roadmap に未反映

## Classification

### Blocking (修正必須)

以下のいずれかに該当する場合、ドラフトの修正が必要:

- 定量的根拠なしの high priority 提案
- high priority が全体の 50% 超
- 実行不可能なアクションが roadmap Phase 1 に含まれている
- KPI 目標が目安の 2 倍以上楽観的
- セクション間に明確な矛盾
- critical severity issue が roadmap に未反映

### Non-blocking (留意事項として記載)

戦略の出力は可能だが、ユーザーに注意を促す:

- 代替案の記載なし
- サンプルサイズが小さい提案（imp 50-100）
- 季節性の影響が不明な KPI 目標
- 専門家間で意見が分かれた提案
- weak 領域の撤退判断が保留

## Loop Protocol

```
Round 1:
  1. 統合ドラフトに対してチェックリスト全項目を評価
  2. 各項目を blocking / non-blocking / pass に分類
  3. blocking 項目ごとに具体的な修正提案を記述
  4. ドラフトを修正

Round 2 (blocking 項目が残存した場合のみ):
  1. 修正後のドラフトを再チェック（blocking 項目のみ）
  2. 解消確認 or 残存理由を記録

Gate:
  - blocking = 0 → Phase 5 (Finalize) へ進行
  - Round 2 後も blocking 残存 → blocking 理由を seo-strategy.md に記載して出力
  - いかなる場合も Round 3 は実施しない（2ラウンド上限）
```

## Output Format

悪魔の代弁者レビュー結果は `seo-strategy.md` の末尾に以下の形式で記載:

```markdown
## Plan Quality Gate

- Devil's advocate review rounds: N
- Blocking findings resolved: yes/no
- Remaining non-blocking concerns:
  - [concern 1]: [rationale]
  - [concern 2]: [rationale]

### Review Summary

| Dimension | Result | Notes |
|---|---|---|
| データ根拠の妥当性 | pass/blocking/non-blocking | ... |
| 優先度の一貫性 | pass/blocking/non-blocking | ... |
| 実行可能性 | pass/blocking/non-blocking | ... |
| 機会コストとトレードオフ | pass/blocking/non-blocking | ... |
| KPI 目標の現実性 | pass/blocking/non-blocking | ... |
| 内部整合性 | pass/blocking/non-blocking | ... |
| 見落としチェック | pass/blocking/non-blocking | ... |
```
