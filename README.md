# Agent Skills Collection

**70+ production-ready skills** for AI coding agents (Claude Code, Codex, and more).

Dev workflow automation, SEO/marketing analytics, blog operations, Git workflow, image/video processing, Google Workspace integration — all in one repo.

Built and maintained by [playpark LLC](https://www.playpark.co.jp/) — an AI development studio specializing in agent-driven workflows and business process automation.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/it-all-playpark/skills.git ~/.claude/skills

# 2. Done. Use skills in Claude Code:
/dev-kickoff 123          # Issue → implementation → PR
/git-commit --all         # Smart commit with Conventional Commits
/sns-announce article.mdx # Generate social media posts
```

For Codex or other agents, symlink to the appropriate directory:

```bash
ln -sf ~/.claude/skills ~/.<tool>/skills
```

### External Skills Integration (skills.sh)

[skills.sh](https://skills.sh) で取得した外部スキルは `.agents/skills/` に配置し、シンボリックリンクで統合できます。

```bash
# Automated symlink management
_lib/infra/link-agent-skills.sh    # Create symlinks + update .gitignore
_lib/infra/unlink-agent-skills.sh  # Remove symlinks
```

## 設定（skill-config.json）

スキルの設定は **グローバル**（ユーザー共通）と **プロジェクト** の2階層で管理できます。プロジェクト設定がグローバル設定を deep merge で上書きします。

### 設定ファイルの配置

```
skill-config.json                              # プロジェクト設定（リポジトリルート）
~/.config/skills/config.json                    # グローバル設定（ツール非依存）
```

### マージ順序（後勝ち）

```
スキル内蔵デフォルト ← グローバル config ← プロジェクト skill-config.json[skill]
                        (グローバル)                         (プロジェクト: 最優先)
```

**設定の読み込み優先順位:**

1. `<project>/skill-config.json` の該当スキルセクション（最優先）
2. グローバル config（`$SKILL_CONFIG_PATH` > `~/.config/skills/config.json` > `~/.claude/skill-config.json`）
3. `.claude/<skill-name>.json`（旧形式、フォールバック）
4. スキル内蔵のデフォルト値

### グローバル設定の例

ユーザー共通のプリファレンスを記述します: `cp skill-config.json ~/.config/skills/config.json`

```jsonc
// ~/.config/skills/config.json (or ~/.claude/skill-config.json)
{
  "sns-announce": {
    "default_lang": "ja",
    "platforms": {
      "x": { "enabled": true },
      "linkedin": { "enabled": true }
    }
  },
  "sns-schedule-post": {
    "timezone": "Asia/Tokyo"
  },
  "trends-analyzer": {
    "geo": "JP"
  }
}
```

### マージ動作例

```jsonc
// ~/.config/skills/config.json (or ~/.claude/skill-config.json) (グローバル)
{
  "sns-announce": {
    "default_lang": "ja",
    "platforms": { "x": { "enabled": true }, "linkedin": { "enabled": true } }
  }
}

// <project>/.claude/skill-config.json (プロジェクト)
{
  "sns-announce": {
    "base_url": "https://example.com",
    "platforms": { "linkedin": { "enabled": false } }
  }
}

// → マージ結果
{
  "sns-announce": {
    "default_lang": "ja",                   // グローバルから継承
    "base_url": "https://example.com",      // プロジェクトで追加
    "platforms": {
      "x": { "enabled": true },             // グローバルから継承
      "linkedin": { "enabled": false }      // プロジェクトで上書き
    }
  }
}
```

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
// <project-root>/skill-config.json
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
# → global + project の merged config が返る
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

### ブログ運用

| スキル | 説明 |
|--------|------|
| `blog-cross-post` | ブログ記事をZenn/Qiita形式に変換 |
| `cross-post-publish` | Zenn/Qiitaクロスポスト一括投稿オーケストレーション |
| `zenn-publish` | Zennへの公開 |
| `qiita-publish` | Qiitaへの公開 |
| `generate-thumbnail` | Gemini APIによるブログサムネイル生成 |
| `get-publish-date` | スケジュール設定に基づく次回公開日算出 |
| `blog-mv-date` | 記事の公開日変更（MDX/画像/seed/SNS予約を一括更新） |
| `blog-swap-dates` | 2記事間の公開日入れ替え（MDX/画像/seed/SNS予約を一括更新） |
| `blog-schedule-overview` | 全記事の公開スケジュールカレンダー表示・空きスロット検出 |
| `blog-fact-check` | 記事内の統計データ・バージョン・料金のファクトチェック |
| `blog-internal-links` | クラスタ内記事間の内部リンク分析・挿入 |
| `blog-seo-improve` | GSC/GAデータに基づく既存記事のSEO改善 |
| `seed-refresh` | seedキャッシュファイルの一括更新 |

### SNS・投稿スケジュール

| スキル | 説明 |
|--------|------|
| `sns-announce` | SNS告知文生成（X/LinkedIn/Facebook/Bluesky/Threads等） |
| `video-announce` | 動画/画像投稿キャプション生成（IG/YouTube Shorts/TikTok） |
| `zernio` | Zernio CLIによるSNS投稿スケジュール・同期（post/sync） |

### 営業・セールス

| スキル | 説明 |
|--------|------|
| `meeting-followup` | カレンダーアポ情報→議事録生成→お礼メール下書き作成 |
| `sales-tracker` | Google Spreadsheetで営業パイプライン管理（3シート構成） |
| `sales-sync` | Gmail確認→営業パイプライン変更検知→スプレッドシート自動更新 |
| `founder-sales` | 創業者向け初期顧客獲得・再現可能な営業プロセス構築 🔗 |
| `enterprise-sales` | エンタープライズセールス・大型案件クロージング 🔗 |
| `building-sales-team` | 営業組織構築・スケーリング 🔗 |
| `sales-enablement` | 営業資料作成（ピッチデッキ/提案書/デモスクリプト等） 🔗 |

### Google Workspace

| スキル | 説明 |
|--------|------|
| `gws-calendar` | Google Calendar管理（イベント操作） 🔗 |
| `gws-calendar-agenda` | Google Calendar全カレンダーの予定一覧表示 🔗 |
| `gws-calendar-insert` | Google Calendarイベント作成 🔗 |
| `gws-docs` | Google Docsの読み書き 🔗 |
| `gws-docs-write` | Google Docsへのテキスト追記 🔗 |

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
| `rust-best-practices` | Rust開発ベストプラクティス（Apollo GraphQL準拠） 🔗 |

### コミュニケーション

| スキル | 説明 |
|--------|------|
| `slack-cli` | Slack操作CLI（チャンネル/メッセージ/スレッド/リアクション） |

### ユーティリティ

| スキル | 説明 |
|--------|------|
| `seed-context` | プロジェクトコンテキスト抽出・保存 |
| `skill-creator` | 新規スキル作成ガイド（当リポジトリ規約版） |
| `skill-retrospective` | スキル実行失敗からの自己改善 |
| `find-skills` | スキル検索・インストール支援 🔗 |
| `claude-zombie-kill` | ゾンビClaude Codeセッション検出・終了 |
| `suica-to-csv` | モバイルSuica明細PDFをマネーフォワード経費CSVに変換 |
| `agent-browser` | ブラウザ自動操作（ページ操作/スクレイピング/テスト） 🔗 |

> 🔗 = skills.sh 由来の外部スキル（`.agents/skills/` からシンボリックリンク）

## 使い方

Claude Code内で `/スキル名` を実行:

```
/git-commit --all
/dev-kickoff 123
/sns-announce
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
│   └── skills/              # skills.sh 等で取得したスキル
├── <skill-name>/            # 各スキル（自作）
│   ├── SKILL.md             # スキル定義（必須）
│   ├── scripts/             # 実行スクリプト
│   ├── references/          # 参照ドキュメント
│   └── assets/              # アセット
├── <skill-name> -> .agents/ # 外部スキル（symlink）
├── .gitignore               # 外部スキルsymlinkを自動管理
└── README.md
```

## Contributing

Issues and Pull Requests are welcome. Each skill follows this structure:

```
<skill-name>/
├── SKILL.md             # Skill definition (required)
├── scripts/             # Execution scripts
├── references/          # Reference documents
└── assets/              # Assets
```

## About playpark LLC

AI開発を専門とするソフトウェア開発スタジオです。AIエージェントを活用した開発ワークフロー自動化、業務プロセスのAI化を得意としています。

- Web: [playpark.co.jp](https://www.playpark.co.jp/)
- Blog: [playpark.co.jp/blog](https://www.playpark.co.jp/blog/) — AI coding tools, agent workflows, and more
- Contact: [playpark.co.jp/contact](https://www.playpark.co.jp/contact/) — AI開発・業務自動化のご相談

## License

各スキルのSKILL.mdを参照してください。
