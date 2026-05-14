# Plan Review Checklist

Implementation plan を批判的にレビューするためのチェックリスト。

## Review Dimensions

### 1. Scope & Requirements Alignment
- 計画が issue の受入基準を全てカバーしているか？
- issue に書かれていない機能を勝手に追加していないか？（YAGNI）
- 計画の Overview が issue の目的と一致しているか？

### 2. File Changes Completeness
- 変更が必要なファイルが全て File Changes に列挙されているか？
- テストファイルが含まれているか？（testing config が tdd/bdd の場合）
- 設定ファイルやマイグレーションファイルの変更漏れはないか？
- 既存ファイルの modify で影響範囲が正しく特定されているか？

### 3. Architecture Decisions
- 各設計判断に「なぜ」が書かれているか？
- 代替案が検討された形跡があるか？（少なくとも重要な判断について）
- 既存コードベースのパターンと一貫しているか？
- 責務の分離は適切か？

### 4. Edge Cases & Error Handling
- Edge Cases セクションに対応方針が書かれているか？（ケース列挙だけでは不十分）
- 異常系（null, 空, 境界値, 認証失敗等）が考慮されているか？
- エラー時のユーザー/システム挙動が明確か？

### 5. Dependencies & Integration
- 外部ライブラリの追加は妥当か？既存の依存で代替できないか？
- 内部モジュール間の依存関係は明確か？
- 破壊的変更がある場合、マイグレーション計画があるか？

### 6. Implementability
- 計画が十分に具体的か？（「適切に実装」等の曖昧な指示がないか）
- Generator (Sonnet) が迷わず実装できる粒度か？
- ファイルパスは具体的か？
- 実装順序に依存関係の矛盾がないか？

### 7. Test Plan Coverage (config.testing != none の場合のみ)
- `## Test Plan` セクションが存在するか？
- 全 acceptance criterion (AC) に最低 1 テストが割り当てられているか？（AC ID が Test Plan に出現するか）
- 各テストに `Expected Initial State` が明記されているか？（原則 `RED`）
- テストファイルのパスが `## File Changes` にも列挙されているか？
- 未カバーの AC があれば **critical** finding。Test Plan セクション自体の欠落も **critical**

### 8. Security & Data Safety
- ユーザー入力のバリデーションが考慮されているか？
- 認証/認可への影響が検討されているか？
- 機密データの扱いが適切か？

### 9. Plan Self-Containment

各 task / セクションが**単独で読めるように**書かれているか？ "paste, don't link" を満たすため、
dev-kickoff orchestrator が task body を verbatim paste した worker は周辺 context を持たない。
plan 内で曖昧参照を含む task は worker を混乱させる。

**Flagging patterns (severity: major / dimension: self_containment)**:

以下の正規表現にマッチする表現が含まれる task / section は finding として上げる:

```
- (上述の通り)
- (上記(に|の)通り)
- (前述(の通り|どおり))
- (Task\s*\d+\s*と(同様|同じ))
- (Task\s*\d+\s*に(倣う|準じる))
- (See (Task|Section)\s*\d+)
- (same\s+as\s+Task\s*\d+)
```

許容例外:
- コミットメッセージのプレフィックス参照（`feat(dev-...)` 等）
- "上述" を含まない section header（"上記内容について" 等の構造的見出しは別判定）

`description` には flagged フレーズの行番号と原文の引用を入れる。`suggestion` には「Task N の本文を
verbatim 展開する」または「該当規約 (specific term + path) を直接書く」と書く。

各 finding は `dimension: "self_containment"`、`topic: "Ambiguous reference: '<phrase>'"` 形式で揃える
ことで dev-flow-doctor の stuck detection が機能する。

詳細: [`_shared/references/subagent-dispatch.md`](../../_shared/references/subagent-dispatch.md#paste-dont-link)

## Blocking Criteria

以下のいずれかに該当する finding は blocking:
- 受入基準の欠落（issue 要件が計画に反映されていない）
- File Changes に明らかな漏れがある
- Architecture Decision に理由がなく、誤った方向に進むリスクがある
- Edge Case に対応方針がない（列挙のみ）
- 依存関係の矛盾（実装不可能な順序）
- セキュリティ上の懸念が無視されている
- **Test Plan セクションの欠落、または AC が Test Plan に未カバー**（config.testing != none の場合）
- **Plan self-containment 違反**: 上記正規表現にマッチする曖昧参照を含む task が存在する（severity: major, dimension: self_containment）

## Review Protocol

1. 各 dimension について計画を評価
2. finding を blocking / non-blocking に分類
3. blocking finding には具体的な修正提案を付ける
4. blocking が 0 になるまで修正ループ（max-rounds まで）
