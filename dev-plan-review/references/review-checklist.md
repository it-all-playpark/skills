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

### 7. Security & Data Safety
- ユーザー入力のバリデーションが考慮されているか？
- 認証/認可への影響が検討されているか？
- 機密データの扱いが適切か？

## Blocking Criteria

以下のいずれかに該当する finding は blocking:
- 受入基準の欠落（issue 要件が計画に反映されていない）
- File Changes に明らかな漏れがある
- Architecture Decision に理由がなく、誤った方向に進むリスクがある
- Edge Case に対応方針がない（列挙のみ）
- 依存関係の矛盾（実装不可能な順序）
- セキュリティ上の懸念が無視されている

## Review Protocol

1. 各 dimension について計画を評価
2. finding を blocking / non-blocking に分類
3. blocking finding には具体的な修正提案を付ける
4. blocking が 0 になるまで修正ループ（max-rounds まで）
