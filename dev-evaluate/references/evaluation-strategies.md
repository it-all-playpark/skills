# Evaluation Strategies

## Strategy Interface

| Field | Description |
|-------|-------------|
| type | タスクタイプ識別子 |
| static_review | コードレビューベースの評価指示（Phase 1、常に実行） |
| runtime_review | 実行環境での検証指示（Phase 2、オプション、null = 未実装） |

## frontend
- static_review: コンポーネント構造、props設計、アクセシビリティ属性（aria-*）、レスポンシブ対応の確認
- runtime_review: null (Phase 2: Playwright でスクリーンショット + インタラクション検証)

## api
- static_review: エンドポイント設計（REST規約）、エラーハンドリング（4xx/5xx）、バリデーション、認証/認可の確認
- runtime_review: null (Phase 2: curl でレスポンス検証)

## refactor
- static_review: 振る舞い保持の diff 分析、テストカバレッジ確認、public API 変更なしの確認
- runtime_review: null

## infrastructure
- static_review: 冪等性、セキュリティ設定（secrets expose なし）、ロールバック可能性の確認
- runtime_review: null

## generic
- static_review: 共通基準のみで評価
- runtime_review: null

## Adding Runtime Review (Phase 2)

To add runtime verification for a task type:
1. Fill in the `runtime_review` field with verification instructions
2. Add necessary tools to SKILL.md `allowed-tools` (e.g., Bash for Playwright/curl)
3. No changes needed to the skill's core workflow — it checks `runtime_review` automatically
