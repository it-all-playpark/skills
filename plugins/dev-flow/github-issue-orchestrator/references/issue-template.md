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
- executor: agent
- タスク:
- 完了条件:

### フェーズ2
- 担当:
- executor: agent
- タスク:
- 完了条件:

### フェーズN
- 担当:
- executor: agent
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
- 各フェーズに担当者・executor・完了条件を必ず書く。

## executor（実行者）

各タスクに `executor: agent` か `executor: human` のどちらかを必ず付ける。human マーカーは固定文字列
`executor: human`（SKILL.md の Executor Classification と同じ文字列。言い換えない）。

human 判定基準（いずれかを要するタスクは `executor: human`）:

1. 外部サービスの管理画面操作・アカウント作成
2. secret・API キーの発行と登録
3. DNS・課金・契約
4. 顧客への確認・承認
5. 本番データの手作業操作
6. 実機での手動確認

基準外は `executor: agent`（既定）。実装 issue（上のテンプレート）には `executor: agent` のタスクだけを
残す。`executor: human` のタスクは下の human issue テンプレートで別 issue に切り出し、先に起票する
（`create_issue.py --kind agent` は本文に `executor: human` が残っていると起票を拒否する）。

## human issue テンプレート

`create_issue.py --kind human` で起票する（`human-task` ラベルが付く）。`## 手順` と、checkbox 付きの
`## 完了条件` は必須（無いと起票を拒否する）。

```markdown
## 背景
- 元の議論 / 実装 issue の目的:
- executor: human
- なぜ人手か: [human 判定基準のどれに当たるか]

## 手順
1. ...
2. ...

## 完了条件
- [ ] [完了を人が確認できる観察可能な状態。例: `API_KEY` が repository secret に登録されている]

## 後続 issue
- [この issue の完了を待つ実装 issue。実装 issue 側に `Blocked by #<この issue>` が付く]
```
