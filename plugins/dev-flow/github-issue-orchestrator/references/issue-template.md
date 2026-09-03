# GitHub Issue Template (Japanese Default)

デフォルト（`--lang` 未指定）はこの日本語テンプレートを使う。`--lang en` のときのみ英語化する。

```markdown
## 背景
- 議論ソース: [link or file]
- 目的:
- 非目標:

## 課題
[何が不足/問題で、なぜ今対応するか]

## スコープ
### 対象範囲（In Scope）
- ...

### 対象外（Out of Scope）
- ...

## 専門観点での調査結果
### Frontend
- 影響:
- 方針:
- リスク:

### Backend
- 影響:
- 方針:
- リスク:

### Infra
- 影響:
- 方針:
- リスク:

## 実装計画
### フェーズ1
- 担当:
- タスク:
- 完了条件:

### フェーズ2
- 担当:
- タスク:
- 完了条件:

### フェーズN
- 担当:
- タスク:
- 完了条件:

## 受け入れ基準（Acceptance Criteria）
- [ ] AC-1 ...
- [ ] AC-2 ...
- [ ] AC-3 ...

## テスト戦略
- Unit:
- Integration:
- E2E:
- Observability checks:

## リリース/ロールバック
- Rollout strategy:
- Rollback trigger:
- Rollback steps:

## リスクと対策
- リスク:
  - 影響:
  - 対策:

## 悪魔の代弁者レビュー履歴
- Round 1 指摘:
- Round 1 修正:
- Round 2 指摘:
- Round 2 修正:
- 最終判定: blocking findings resolved = yes/no

## 未解決事項（Open Questions）
- ...
```

品質基準:
- 各セクションは具体的かつ検証可能に書く。
- 「性能改善」などの曖昧表現は避け、指標/閾値を明記する。
- 各フェーズに担当者と完了条件を必ず書く。
