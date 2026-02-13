# Claude Code Skills Collection

Claude Codeの機能を拡張するスキルコレクションです。

## インストール

```bash
# クローン
git clone https://github.com/it-all-playpark/skills.git ~/.claude/skills
```

## スキル一覧

### 開発ワークフロー

| スキル | 説明 |
|--------|------|
| `dev-flow` | Issue → LGTM までのE2E開発フロー自動化 |
| `dev-kickoff` | git worktreeを使った機能開発オーケストレーター |
| `dev-implement` | TDD/BDD/DDD戦略での機能実装 |
| `dev-issue-analyze` | GitHub Issue分析・実装計画 |
| `dev-validate` | 実装検証・テスト実行 |
| `dev-build` | ビルド・コンパイル・パッケージング |
| `dev-cleanup` | デッドコード削除・構造最適化 |

### Git操作

| スキル | 説明 |
|--------|------|
| `git-commit` | 変更分析・Conventional Commits生成 |
| `git-pr` | GitHub PR作成 |
| `git-prepare` | 機能開発用worktree準備 |

### PR/レビュー

| スキル | 説明 |
|--------|------|
| `pr-review` | PRレビュー |
| `pr-fix` | レビューフィードバックに基づくPR修正 |
| `pr-iterate` | LGTM取得までの改善ループ |

### テスト

| スキル | 説明 |
|--------|------|
| `test-unit` | ユニットテスト実行 |
| `test-integration` | 統合テスト実行 |
| `test-e2e` | E2Eテスト実行 |
| `test-watch` | ウォッチモードでのテスト |
| `test-coverage` | カバレッジレポート生成 |

### ドキュメント

| スキル | 説明 |
|--------|------|
| `doc-generate` | ドキュメント生成（JSDoc/API/ガイド） |
| `doc-index` | プロジェクトドキュメント・知識ベース生成 |
| `idea-to-document` | アイデア・メモを構造化ドキュメントに変換 |

### 分析・思考

| スキル | 説明 |
|--------|------|
| `think-deep` | 深い分析・アーキテクチャ決定 |
| `think-analyze` | コード品質・セキュリティ・パフォーマンス分析 |
| `plan-brainstorm` | 要件探索・ブレインストーミング |
| `plan-workflow` | PRD・要件から実装ワークフロー生成 |

### セッション管理

| スキル | 説明 |
|--------|------|
| `session-load` | セッション開始・コンテキスト読み込み |
| `session-save` | セッション終了・コンテキスト保存 |

### リポジトリ情報エクスポート

| スキル | 説明 |
|--------|------|
| `repo-export` | リポジトリ内容をMarkdownにエクスポート |
| `repo-issue` | GitHub Issue情報エクスポート |
| `repo-pr` | GitHub PR情報エクスポート |
| `repo-commit` | コミット履歴エクスポート |

### 画像処理

| スキル | 説明 |
|--------|------|
| `image-convert` | 画像フォーマット変換（vips） |
| `image-resize` | 画像リサイズ（vips） |
| `image-remove-bg` | 背景除去（rembg） |

### ブログ・SNS

| スキル | 説明 |
|--------|------|
| `blog-cross-post` | ブログ記事をZenn/Qiita形式に変換 |
| `zenn-publish` | Zennへの公開 |
| `qiita-publish` | Qiitaへの公開 |
| `sns-announce` | SNS告知文生成 |
| `sns-schedule-post` | SNS投稿スケジュール（Late API） |
| `sns-dedupe` | SNS投稿重複除去 |

### ユーティリティ

| スキル | 説明 |
|--------|------|
| `zip` | ディレクトリのzip圧縮 |
| `seed-context` | プロジェクトコンテキスト抽出・保存 |
| `skill-creator` | 新規スキル作成ガイド |
| `mcp-guide` | MCPサーバー選択ガイド |

## 使い方

Claude Code内で `/スキル名` を実行:

```
/git-commit --all
/dev-kickoff 123
/think-deep --level ultrathink
```

## 構造

```
skills/
├── _lib/                    # 共有ライブラリ
│   ├── infra/               # リポジトリ基盤管理スクリプト
│   ├── scripts/             # スキル共通ユーティリティ
│   ├── schemas/             # JSON Schema定義
│   └── templates/           # テンプレート
├── <skill-name>/
│   ├── SKILL.md             # スキル定義（必須）
│   ├── scripts/             # 実行スクリプト
│   ├── references/          # 参照ドキュメント
│   └── assets/              # アセット
└── README.md
```

## ライセンス

各スキルのSKILL.mdを参照してください。
