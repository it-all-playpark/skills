# Agent Skills Collection

AIコーディングエージェント（Claude Code / Codex 等）の機能を拡張するスキルコレクションです。

## インストール

```bash
# クローン（任意のパスに配置可能）
git clone https://github.com/it-all-playpark/skills.git ~/skills

# 各ツールからシンボリックリンクで参照
# SKILLS_DIR は実体リポジトリのパスを指定
ln -sf ~/skills ~/.<tool>/skills   # <tool>: claude, codex など
```

### 外部スキルの取り込み（skill.sh 由来）

[skill.sh](https://skill.sh) 等で取得した外部スキルは `.agents/skills/` に配置し、シンボリックリンクで統合します。

```bash
# 外部スキルの配置
.agents/skills/<skill-name>/   # 外部スキルの実体

# シンボリックリンクの自動管理
_lib/infra/link-agent-skills.sh    # リンク作成 + .gitignore 自動更新
_lib/infra/unlink-agent-skills.sh  # リンク解除
```

`link-agent-skills.sh` を実行すると:
1. `.agents/skills/` 配下の全スキルを repo root にシンボリックリンク
2. `.gitignore` に自動追記（git status を汚さない）
3. 不要になった stale symlink を自動クリーンアップ
4. 冪等: 何度実行しても同じ結果

## プロジェクト設定（skill-config.json）

各プロジェクトの `.claude/skill-config.json` にスキル固有の設定を記述できます。スキルはこのファイルから自動的に設定を読み込みます。

```jsonc
// <project-root>/.claude/skill-config.json
{
  "skill-name": { /* 各スキルの設定 */ }
}
```

**設定の読み込み優先順位:**
1. `.claude/skill-config.json` の該当スキルセクション
2. `.claude/<skill-name>.json`（旧形式、フォールバック）
3. スキル内蔵のデフォルト値

### 対応スキルと設定項目

#### ga-analyzer

| キー | 型 | 説明 |
|------|-----|------|
| `property_id` | string | GA4 プロパティID（必須） |
| `default_report_type` | string | レポート種別（`"full"` 等） |
| `date_range_days` | number | 分析対象日数 |
| `output_dir` | string | 出力先ディレクトリ |

#### gsc

| キー | 型 | 説明 |
|------|-----|------|
| `site` | string | GSCサイトURL（例: `"sc-domain:example.com"`） |
| `default_days` | number | デフォルト分析日数 |
| `default_limit` | number | 取得件数上限 |
| `output_dir` | string | 出力先ディレクトリ |

#### sns-announce

| キー | 型 | 説明 |
|------|-----|------|
| `base_url` | string | 記事のベースURL |
| `url_pattern` | string | URLパターン（例: `"/blog/{slug}"`） |
| `default_lang` | string | 投稿言語（デフォルト: `"ja"`） |
| `platforms` | object | プラットフォーム別設定 |
| `platforms.<name>.enabled` | boolean | 有効/無効 |
| `platforms.<name>.char_limit` | number | 文字数上限 |
| `output` | object | 出力設定 |
| `output.dir` | string | 出力ディレクトリ |
| `output.pattern` | string | ファイル名パターン |
| `schedule.enabled` | boolean | 自動スケジュール有効/無効 |
| `schedule.mode` | string | スケジュールモード |

#### sns-schedule-post

| キー | 型 | 説明 |
|------|-----|------|
| `timezone` | string | タイムゾーン（デフォルト: `"Asia/Tokyo"`） |
| `default_platforms` | string[] | デフォルト投稿先 |

#### blog-cross-post

| キー | 型 | 説明 |
|------|-----|------|
| `base_url` | string | ブログのベースURL |
| `content_dir` | string | 記事ソースディレクトリ（デフォルト: `"content/blog"`） |
| `blog_path_prefix` | string | URLパスプレフィックス（デフォルト: `"/blog/"`） |
| `company_name` | string | 会社名（CTA表示用） |
| `contact_url` | string | お問い合わせURL（CTA表示用） |
| `cross_post_categories` | string[] | クロスポスト対象カテゴリ |

#### trends-analyzer

| キー | 型 | 説明 |
|------|-----|------|
| `geo` | string | 地域コード（デフォルト: `"JP"`） |
| `timeframe` | string | 分析期間（デフォルト: `"today 3-m"`） |
| `top_n` | number | 上位N件取得 |
| `title_strip_patterns` | string[] | タイトルから除去する正規表現 |

#### seo-content-planner

| キー | 型 | 説明 |
|------|-----|------|
| `site` | string | GSCサイトURL |
| `top_n` | number | 上位N件取得 |
| `output_dir` | string | 出力先ディレクトリ |

#### seo-strategy

| キー | 型 | 説明 |
|------|-----|------|
| `site` | string | サイトドメイン |
| `content_path_prefix` | string | URLパスプレフィックス（デフォルト: `"/blog/"`） |
| `content_dir` | string | 記事ディレクトリ（デフォルト: `"content/blog"`） |
| `cluster_keywords` | object | クラスタ名→キーワード配列のマッピング |
| `unclustered_min_impressions` | number | 未分類の最低表示回数（デフォルト: `20`） |
| `cluster_suggestion_min_impressions` | number | クラスタ提案の最低表示回数（デフォルト: `50`） |
| `cluster_suggestion_top_n` | number | クラスタ提案の最大件数（デフォルト: `5`） |

### 設定例

```jsonc
// <project-root>/.claude/skill-config.json
{
  "ga-analyzer": {
    "property_id": "123456789",
    "output_dir": "claudedocs"
  },
  "sns-announce": {
    "base_url": "https://example.com",
    "url_pattern": "/blog/{slug}",
    "platforms": {
      "x": { "enabled": true },
      "linkedin": { "enabled": true }
    }
  },
  "blog-cross-post": {
    "base_url": "https://example.com",
    "content_dir": "content/blog"
  }
}
```

### スクリプトからの利用

```bash
# Bash: _lib/common.sh の load_skill_config を使用
source "$SKILLS_DIR/_lib/common.sh"
config=$(load_skill_config "ga-analyzer")

# Python: _lib/config.py の load_skill_config を使用
from _lib.config import load_skill_config
config = load_skill_config("ga-analyzer")
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
| `dev-decompose` | 大規模Issue並列サブタスク分解 |
| `dev-integrate` | 並列サブタスクブランチのマージ・統合テスト |
| `dev-env-setup` | worktree作成後の依存関係自動インストール |
| `dev-flow-doctor` | dev-flowの健全性診断・改善提案 |
| `dep-guardian` | 依存関係更新PRのトリアージ・テスト・バッチマージ |

### Git操作

| スキル | 説明 |
|--------|------|
| `git-commit` | 変更分析・Conventional Commits生成 |
| `git-pr` | GitHub PR作成 |
| `git-prepare` | 機能開発用worktree準備 |
| `sync-env` | ソースリポジトリからworktreeへ.envファイル同期 |

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
| `api-contract-testing` | APIコントラクトテスト（Pact等） 🔗 |

### ドキュメント

| スキル | 説明 |
|--------|------|
| `doc-generate` | ドキュメント生成（JSDoc/API/ガイド） |
| `doc-index` | プロジェクトドキュメント・知識ベース生成 |
| `idea-to-document` | アイデア・メモを構造化ドキュメントに変換 |
| `marp-slide` | Marpプレゼンテーションスライド生成 |

### 分析・思考

| スキル | 説明 |
|--------|------|
| `think-deep` | 深い分析・アーキテクチャ決定 |
| `think-analyze` | コード品質・セキュリティ・パフォーマンス分析 |
| `plan-brainstorm` | 要件探索・ブレインストーミング |
| `plan-workflow` | PRD・要件から実装ワークフロー生成 |
| `simplify` | 変更コードの品質・効率レビュー＆修正 |
| `code-audit-team` | マルチエージェントコード監査（セキュリティ/パフォーマンス/アーキテクチャ） |
| `bug-hunt` | マルチエージェント協調バグ調査 |
| `incident-response` | 並列インシデント調査（コード/ログ/設定分析） |
| `github-issue-orchestrator` | 議論からGitHub Issue作成（技術調査・レビュー付き） |

### SEO/マーケティング分析

| スキル | 説明 |
|--------|------|
| `ga-analyzer` | GA4データ分析・サイト改善アドバイス |
| `gsc` | Google Search Consoleクエリ・SEOデータ取得 🔗 |
| `trends-analyzer` | Google Trendsキーワードトレンド分析 |
| `seo-content-planner` | GA4+Trends統合分析によるSEO記事ネタ提案 |
| `seo-strategy` | GA4+GSC+Trends統合の包括的SEO戦略 |

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

### 動画

| スキル | 説明 |
|--------|------|
| `remotion-video` | Remotionによる動画制作（React） |
| `remotion-best-practices` | Remotion開発ベストプラクティス 🔗 |
| `yt-chorus-extract` | YouTube動画からサビ音声クリップ抽出 |
| `youtube-channels` | YouTubeチャンネル情報・動画一覧取得 |

### ブログ・SNS

| スキル | 説明 |
|--------|------|
| `blog-cross-post` | ブログ記事をZenn/Qiita形式に変換 |
| `zenn-publish` | Zennへの公開 |
| `qiita-publish` | Qiitaへの公開 |
| `sns-announce` | SNS告知文生成 |
| `sns-schedule-post` | SNS投稿スケジュール（Late API） |
| `sns-dedupe` | SNS投稿重複除去 |
| `video-announce` | 動画/画像投稿キャプション生成（IG/YouTube Shorts/TikTok） |
| `video-schedule-post` | 動画プラットフォーム投稿スケジュール（Late API） |

### ビジネス・戦略

| スキル | 説明 |
|--------|------|
| `strategy-and-competitive-analysis` | 事業戦略・競合分析フレームワーク 🔗 |
| `pricing-strategy` | 価格戦略・パッケージング・マネタイズ 🔗 |
| `biz-card-to-sheet` | 名刺画像からスプレッドシートへ登録 |
| `biz-card-search` | 登録済み名刺データ検索 |

### UI/UX・フロントエンド

| スキル | 説明 |
|--------|------|
| `ui-ux-pro-max` | UI/UXデザインインテリジェンス（50スタイル/21パレット） 🔗 |
| `vercel-react-best-practices` | React/Next.jsパフォーマンス最適化ガイドライン 🔗 |

### バックエンド・データベース

| スキル | 説明 |
|--------|------|
| `fastify-best-practices` | Fastify開発ベストプラクティス 🔗 |
| `prisma-cli` | Prisma CLIコマンドリファレンス 🔗 |
| `neon-postgres` | Neon Serverless Postgresガイド 🔗 |

### ユーティリティ

| スキル | 説明 |
|--------|------|
| `zip` | ディレクトリのzip圧縮 |
| `seed-context` | プロジェクトコンテキスト抽出・保存 |
| `skill-creator` | 新規スキル作成ガイド |
| `skill-retrospective` | スキル実行失敗からの自己改善 |
| `find-skills` | スキル検索・インストール支援 🔗 |
| `claude-zombie-kill` | ゾンビClaude Codeセッション検出・終了 |
| `suica-to-csv` | モバイルSuica明細PDFをマネーフォワード経費CSVに変換 |
| `agent-browser` | ブラウザ自動操作（ページ操作/スクレイピング/テスト） 🔗 |

> 🔗 = skill.sh 由来の外部スキル（`.agents/skills/` からシンボリックリンク）

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
│   │   ├── link-agent-skills.sh    # 外部スキルのsymlink管理
│   │   └── unlink-agent-skills.sh  # symlink解除
│   ├── scripts/             # スキル共通ユーティリティ
│   ├── schemas/             # JSON Schema定義
│   ├── templates/           # テンプレート
│   ├── common.sh            # Bash共通関数（設定読み込み等）
│   └── config.py            # Python共通設定ローダー
├── .agents/                 # 外部スキル実体（gitignored）
│   └── skills/              # skill.sh 等で取得したスキル
├── <skill-name>/            # 各スキル（自作）
│   ├── SKILL.md             # スキル定義（必須）
│   ├── scripts/             # 実行スクリプト
│   ├── references/          # 参照ドキュメント
│   └── assets/              # アセット
├── <skill-name> -> .agents/ # 外部スキル（symlink）
├── .gitignore               # 外部スキルsymlinkを自動管理
└── README.md
```

## ライセンス

各スキルのSKILL.mdを参照してください。
