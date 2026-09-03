# Agent Skills Collection

**70+ production-ready skills** for AI coding agents (Claude Code, Codex, and more).

Dev workflow automation, SEO/marketing analytics, blog operations, Git workflow, image/video processing, Google Workspace integration — all in one repo.

Built and maintained by [playpark LLC](https://www.playpark.co.jp/) — an AI development studio specializing in agent-driven workflows and business process automation.

## Quick Start

本 repo は 3 つの Claude Code plugin（`playpark-core` / `dev-flow` / `playpark-skills`）に
分かれています。導入方法は用途によって 2 通りあります。

### 配布側インストール（copy mode）

他リポジトリで dev-flow だけ、あるいは全スキルを使いたい場合はこちら。marketplace 経由で
version 固定の copy が install されます。

```
/plugin marketplace add it-all-playpark/skills
/plugin install playpark-core@playpark    # 共有基盤（_lib/common.sh, bin/journal）
/plugin install dev-flow@playpark         # issue-to-LGTM ワークフロー（playpark-core は dependencies で自動解決）
/plugin install playpark-skills@playpark  # 個人用スキル一式（任意）
```

Use skills in Claude Code:

```
/dev-flow 123             # Issue → implementation → PR → LGTM (dynamic workflow)
/git-commit --all         # Smart commit with Conventional Commits
/sns-announce article.mdx # Generate social media posts
```

### 自分用インストール（link mode）

本 repo を手元で clone して開発し、編集を即座に反映させたい場合はこちら（dev-flow 開発者向け）。

1. **旧 symlink 方式の撤去**: `~/.claude/skills` / `~/.claude/workflows` / `~/.claude/agents`
   への symlink 3 本を `rip` で撤去してください（残すと bare 名 workflow の解決先が plugin 経路と
   symlink 経路のどちらになるか不定になります）。

   ```bash
   rip ~/.claude/skills ~/.claude/workflows ~/.claude/agents
   ```

2. **dotfiles settings への登録**: マシン固有パスを含む plugin 登録は dotfiles repo 側の
   settings.json で行います。`extraKnownMarketplaces` に command source（本 repo の絶対パス）を
   `"mode": "link"` で登録し、`enabledPlugins` に `playpark-core` / `dev-flow` /
   `playpark-skills` の 3 件を並べます（マシン固有パスを本 repo の git 管理ファイルに持ち込まない
   ため。登録手順は起票済みの dotfiles issue を参照）。

3. **個別 install**: command source（link mode）の plugin は `dependencies` が自動解決されないため、
   3 plugin を個別に `/plugin install` してください。

4. **再起動して解決確認**: Claude Code を再起動したうえで、以下を確認します。

   ```bash
   command -v journal              # playpark-core の bin/journal が解決すること
   command -v secfloor-classify    # dev-flow の bin/ が解決すること
   ```

   `/dev-flow <issue>` を実行し、`dev-flow:dev-flow-run` が起動することを確認してください。

5. **即時反映の確認**: link mode では repo のファイル編集が再 install なしに反映されます。
   任意の SKILL.md を 1 語変更 → `/reload-plugins` → 反映を確認してください。

`dev-flow` plugin では skills（フラット構造）と `agents/` 配下の 11 agent が plugin として
認識されます。plugin の subagent は plugin root の `agents/` からのみ読み込まれるため、
agent 定義の実体は `plugins/dev-flow/agents/` に置き、`plugins/dev-flow/.claude/agents` は
そこへの symlink にしてあります（定義は 1 箇所だけで、コピーの同期は不要）。

この向きは意図的です。symlink は `core.symlinks=false` の環境（Developer Mode 無効の Windows 等）
では中身がパス文字列の通常ファイルとして checkout されるため、`agents/` 側を symlink にすると
plugin install が skill だけ読み込んで **agent が 0 件のまま成功したように見える**。実体を
`agents/` に置けば、そうした環境で影響を受けるのは `plugins/dev-flow/.claude/agents`（本 repo で
dev-flow を開発する場合のみ使う）だけで済みます。`tests/plugin-manifest.bats` がこの向きを pin します。

従来の clone + symlink 方式（Codex / Antigravity など cross-vendor 向け）はそのまま併存して使えます。

For Codex or other agents, symlink to the appropriate directory:

```bash
ln -sf ~/.claude/skills ~/.<tool>/skills
```

### External Skills Integration (skills.sh)

[skills.sh](https://skills.sh) で取得した外部スキルは `.agents/skills/` に配置し、シンボリックリンクで統合できます。

```bash
# Automated symlink management
plugins/playpark-core/_lib/infra/link-agent-skills.sh    # Create symlinks + update .gitignore
plugins/playpark-core/_lib/infra/unlink-agent-skills.sh  # Remove symlinks
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
# Bash: playpark-core の _lib/common.sh を PATH 上の bin/journal 経由で解決する
# （plugin root は version+hash 付き cache パスなので相対 `../` では跨げない）
# → global + project の merged config が返る
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"
config=$(load_skill_config "ga-analyzer")

# Python: playpark-skills 同一 plugin 内の _lib/config.py を相対 import
from _lib.config import load_skill_config
config = load_skill_config("ga-analyzer")
```

## スキル一覧

### 開発ワークフロー

| スキル | 説明 |
|--------|------|
| `dev-flow` | Issue → LGTM までのE2E開発フロー (dynamic workflow: `plugins/dev-flow/.claude/workflows/dev-flow.js`) |
| `dev-issue-analyze` | GitHub Issue分析・実装計画 |
| `dev-flow-doctor` | dev-flowの健全性診断・改善提案 |
| `dep-guardian` | 依存関係更新PRのトリアージ・テスト・バッチマージ |

> `dev-flow` の判断系 leaf (計画/レビュー/実装/評価) は subagent (`plugins/dev-flow/agents/`) として実装。
> 最終 PR レビューは `dev-flow:pr-iterate` workflow (`/pr-iterate <pr>` で単体起動も可)。

📊 **[dev-flow Pipeline Atlas](docs/dev-flow-atlas.md)** — 10 phase のパイプライン・shape 判定・
`pr-iterate` ループ・merge tier 判定を mermaid 図で示した実装ベースの索引。
規約の正典は [`.claude/rules/dev-flow.md`](.claude/rules/dev-flow.md)。

### Git操作

| スキル | 説明 |
|--------|------|
| `git-commit` | 変更分析・Conventional Commits生成 |
| `git-pr` | GitHub PR作成 |
| `sync-env` | ソースリポジトリからworktreeへ.envファイル同期 |

### PR/レビュー

| スキル | 説明 |
|--------|------|
| `pr-iterate` | LGTM取得までの review ⇄ fix 改善ループ (dynamic workflow) |

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

### ブログ運用

| スキル | 説明 |
|--------|------|
| `blog-cross-post` | ブログ記事をZenn/Qiita形式に変換 |
| `cross-post-publish` | Zenn/Qiitaクロスポスト一括投稿オーケストレーション |
| `zenn-publish` | Zennへの公開 |
| `qiita-publish` | Qiitaへの公開 |
| `generate-thumbnail` | Codex CLI built-in image_gen（gpt-image-2）によるブログサムネイル生成 |
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

### Google Workspace

| スキル | 説明 |
|--------|------|
| `gws-calendar-agenda` | Google Calendar全カレンダーの予定一覧表示 🔗 |

### ビジネス・戦略

| スキル | 説明 |
|--------|------|
| `pricing-strategy` | 価格戦略・パッケージング・マネタイズ 🔗 |
| `biz-card-to-sheet` | 名刺画像からスプレッドシートへ登録 |
| `biz-card-search` | 登録済み名刺データ検索 |

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
/dev-flow 123
/sns-announce
```

## 構造

本 repo は 3 plugin 構成です（`.claude-plugin/marketplace.json` に登録）。

```
skills/
├── plugins/
│   ├── playpark-core/                    # 共有基盤 plugin（skills: 1 本）
│   │   ├── _lib/
│   │   │   ├── common.sh                 # Bash共通関数（設定読み込み等）
│   │   │   └── infra/                    # リポジトリ基盤管理スクリプト
│   │   │       ├── link-agent-skills.sh    # 外部スキルのsymlink管理
│   │   │       └── unlink-agent-skills.sh  # symlink解除
│   │   ├── _shared/
│   │   │   └── references/subagent-dispatch.md  # Subagent dispatch 必須5要素
│   │   ├── bin/journal                   # core bare 名 wrapper（1本）
│   │   └── skill-retrospective/          # 唯一の skill
│   ├── dev-flow/                         # issue-to-LGTM ワークフロー plugin（5 skills, 11 agents）
│   │   ├── .claude/
│   │   │   ├── workflows/                # dynamic workflow js（dev-flow.js / pr-iterate.js 等）
│   │   │   └── agents -> ../agents       # symlink（plugin subagent 読み込み用）
│   │   ├── agents/                       # 11 dev-flow agent 実体
│   │   ├── _lib/                         # workflow のロジック本体・test
│   │   ├── _shared/scripts/              # dev-flow 共通スクリプト
│   │   ├── bin/                          # dev-flow bare 名 wrapper（17本）
│   │   └── dev-flow/, dev-flow-doctor/, dev-flow-improve/, dev-issue-analyze/,
│   │       github-issue-orchestrator/（SKILL.md 5本）, pr-iterate/（workflow のみ・SKILL.md 無し）
│   └── playpark-skills/                  # 個人用スキル plugin（dependencies: playpark-core）
│       ├── _lib/config.py                # Python共通設定ローダー
│       ├── _shared/                      # スキル共通ユーティリティ・schemas・templates
│       ├── <skill-name>/                 # 各スキル（自作）
│       │   ├── SKILL.md                  # スキル定義（必須）
│       │   ├── scripts/                  # 実行スクリプト
│       │   ├── references/               # 参照ドキュメント
│       │   └── assets/                   # アセット
│       └── <skill-name> -> ../../.agents/skills/<name>  # 外部スキル（symlink）
├── .agents/skills/                       # 外部スキル実体（gitignored）
├── tools/                                 # sync-inlines.mjs 等 repo 全体ツール
├── tests/                                 # bats / vitest ランナーと横断テスト
├── docs/                                  # dev-flow-atlas.md 等ドキュメント
├── .claude/rules/                         # dev-flow.md（正典）
├── .claude-plugin/marketplace.json        # 3 plugin の登録
├── .gitignore                             # 外部スキルsymlinkを自動管理
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

### テスト実行

`bash tests/run-all-bats.sh` / `bash tests/run-node-tests.sh` は `plugins/playpark-core/bin` と
`plugins/dev-flow/bin` を PATH 先頭へ自動で前置してから実行します（cross-plugin の
`_lib/common.sh` locator が PATH 上の `bin/journal` をアンカーに解決するため）。個別の `.bats`
ファイルを単体実行する場合は同じ前置を自分で行ってください。

```bash
PATH="<repo>/plugins/playpark-core/bin:<repo>/plugins/dev-flow/bin:$PATH" bats <file>
```

## veridelta dogfooding

本 repo は [veridelta](https://github.com/it-all-playpark/veridelta)（`vdelta` CLI）を
dev-flow の redgreen 判定フックにdogfooding導入している（`.claude/redgreen.conf`）。

- **運用ルール**: vdelta の摩擦・バグ・欲しい機能に気づいたら
  [veridelta repo](https://github.com/it-all-playpark/veridelta) に issue を起票し、
  本 repo の issue [#356](https://github.com/it-all-playpark/skills/issues/356) にリンクを残すこと。
- **移行時実測値**（node --test → vitest 移行、2026-07-16）: `node --test` 1007 tests /
  `vitest` 1007 tests passed（総件数一致を確認済み）。
- **記録範囲**: vdelta の verdict（`vdelta compare --report json` の出力）は dev-flow
  telemetry handoff の pending JSON（`~/.claude/journal/pending/`）に書き出されるところまでが
  本 issue の記録範囲。journal 本体（`journal.sh log`）への反映は dotfiles 側 Stop hook
  （`stop-devflow-telemetry.sh`）の jq whitelist 拡張が必要なため別 issue とする。

## About playpark LLC

AI開発を専門とするソフトウェア開発スタジオです。AIエージェントを活用した開発ワークフロー自動化、業務プロセスのAI化を得意としています。

- Web: [playpark.co.jp](https://www.playpark.co.jp/)
- Blog: [playpark.co.jp/blog](https://www.playpark.co.jp/blog/) — AI coding tools, agent workflows, and more
- Contact: [playpark.co.jp/contact](https://www.playpark.co.jp/contact/) — AI開発・業務自動化のご相談

## License

各スキルのSKILL.mdを参照してください。
