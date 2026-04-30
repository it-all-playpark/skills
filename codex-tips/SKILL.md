---
name: codex-tips
description: |
  OpenAI Codex CLI の上級者向け tips・tricks・設定パターン・内部挙動をWeb検索で収集し、
  実践的なコード例付きの構造化 Markdown を生成する。初心者向けの基本操作は一切含まない。
  Use when: (1) Codex CLI の最新 tips やベストプラクティスを深掘りしたい,
  (2) config.toml/profiles/sandbox/MCP/approval_policy 等の高度な設定パターンを知りたい,
  (3) Codex のパフォーマンスチューニングやモデル選択を調べたい,
  (4) headless 運用 (codex exec) や CI/CD・GitHub Action 統合の実装例を集めたい,
  (5) keywords: Codex tips, OpenAI Codex CLI, config.toml, codex exec, spawn_agent,
  multi_agent, sandbox_mode, approval_policy, AGENTS.md, MCP, plugins, profiles,
  reasoning effort, headless, power user, harness design
  Accepts args: [--focus config|mcp|performance|workflow|plugins|undocumented|all] [--days N] [--output PATH]
allowed-tools:
  - WebSearch
  - WebFetch
  - Read
  - Write
  - Agent
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
---

# Codex Tips (Deep Dive)

OpenAI Codex CLI の上級者向け tips を Web 検索で収集し、Fact Check・実装例付きの構造化 Markdown を生成する。

**対象**: `~/.codex/config.toml`, profiles, sandbox_mode, approval_policy, MCP servers, plugins/skills, multi_agent (`spawn_agent` / `wait` / `close_agent`), `codex exec` (headless), GitHub Action, AGENTS.md 設計、reasoning effort、内部挙動など。
**除外**: 基本操作（インストール、初回 `codex login`、`/help` の使い方等）は収集しない。

## Usage

```
/codex-tips [--focus config|mcp|performance|workflow|plugins|undocumented|all] [--days 14] [--output ./claudedocs/]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--focus` | `all` | 特定領域に絞る。`config`: config.toml/profiles/sandbox/approval_policy, `mcp`: MCP サーバー統合, `performance`: モデル選択・reasoning effort・コスト最適化, `workflow`: multi_agent・headless `codex exec`・CI/CD・GitHub Action, `plugins`: plugin manifest・skills 自動発見・AGENTS.md 設計, `undocumented`: 環境変数・隠し CLI フラグ・内部挙動 |
| `--days` | `14` | 遡る日数（tips は鮮度より深さ重視のため長め） |
| `--output` | `./claudedocs/` | 出力先ディレクトリ（`skill-config.json` の `output_dir` で上書き可）。出力ファイル名は `cdx-tips-YYYY-MM-DD.md` |

## Config

プロジェクトの `skill-config.json`（ルートまたは `.claude/`）に `codex-tips.output_dir` があれば `--output` のデフォルト値として使用する。`--output` 引数が明示的に渡された場合はそちらを優先。

```jsonc
// .claude/skill-config.json
{
  "codex-tips": {
    "output_dir": "news"   // → cdx-tips-YYYY-MM-DD.md を news/ に出力
  }
}
```

解決順序: `--output` 引数 > `skill-config.json` > デフォルト (`./claudedocs/`)

## Depth Filter（重要）

収集した情報は以下の基準でフィルタリングする。通過しないものは出力に含めない。

| 含める | 除外する |
|--------|----------|
| `config.toml` の具体的な TOML 設定例 | 「Codex は便利です」系の感想記事 |
| profiles / sandbox_mode / approval_policy の実装パターン | インストール手順・基本コマンド紹介 |
| MCP サーバーの `[[mcp_servers]]` 設定・活用例 | 公式ドキュメントのそのままコピー |
| reasoning effort / model_provider の計測値・最適化 | 「AI コーディングの未来」系の展望記事 |
| `codex exec` (headless) ・ GitHub Action の実装例 | 他ツール（Cursor, Claude Code）との単純比較記事 |
| AGENTS.md / plugin.json / skills の設計パターン | バージョン番号の羅列だけのリリースノート |
| `spawn_agent` / `wait` / `close_agent` の並列フロー実装例 | 一般的なプロンプトエンジニアリング論 |
| 環境変数・隠し CLI フラグ・undocumented features | 単なる「Codex を使ってみた」体験談 |

## Model Strategy

処理フェーズごとにモデルを分離し、コスト効率を最適化する。

| Phase | Model | 理由 |
|-------|-------|------|
| Step 1: 調査設計（クエリ策定） | 親セッション (Opus) | 検索空間の設計で情報の質が決まる |
| Step 2: 検索・取得（A-D） | `model: "haiku"` | クエリ実行＋構造化返却のみ |
| Step 2: 検索・取得（E-F） | `model: "sonnet"` | 検索中の判断（未公開機能の評価等）が必要 |
| Step 3: URL 重複排除 | 親セッション (Opus) | 軽量処理、別エージェント不要 |
| Step 4: 詳細取得 | `model: "haiku"` | URL を fetch して生テキスト返却のみ |
| Step 5: Fact Check | `model: "opus"` | TOML キー・schema・CLI フラグの厳密照合 |
| Step 5: Implementation | `model: "opus"` | コピペ可能な設定の創造的構築 |

## Workflow

```
Step 1: Parse args → skill-config.json 読込 → 日付範囲計算、出力ファイル名: cdx-tips-YYYY-MM-DD.md（親 Opus）
Step 2: Parallel search (6 categories × Agent, model: haiku/sonnet)
Step 3: Depth filter + URL 重複排除（親 Opus）
Step 4: WebFetch で重複排除済み URL から詳細取得（model: haiku）
Step 5: Fact Check Agent (model: opus) + Implementation Agent (model: opus)（並列）
Step 6: Deduplicate, rank by actionability → Format MD → Save（親 Opus）
```

## Step 2: Parallel Deep Search

Agent ツールで6カテゴリを**並列**検索する。

| Category | 内容 | 深掘りポイント | Model |
|----------|------|---------------|-------|
| A: Config & Profiles | `~/.codex/config.toml`, profiles, `sandbox_mode`, `approval_policy`, `model_provider` | TOML 構造、profile 切替パターン、sandbox/approval の組合せ | `haiku` |
| B: MCP Integration | `[[mcp_servers]]` 設定、MCP サーバー自作・活用例 | transport 設定、認証、複数サーバー連携 | `haiku` |
| C: Performance & Cost | モデル選択、reasoning effort、コンテキスト管理 | 計測方法、具体的な数値、before/after | `haiku` |
| D: Workflow & Automation | `multi_agent`, `spawn_agent`, `codex exec` (headless), GitHub Action, CI/CD | 並列実行フロー、headless スクリプト例 | `haiku` |
| E: Plugins & Skills | plugin manifest, skills 自動発見, AGENTS.md, named agent dispatch | 構造設計、template 管理、cross-platform 対応 | `sonnet` |
| F: Undocumented & Advanced | 環境変数、CLI フラグ、内部挙動、エッジケース | 公式ドキュメントに載っていない情報 | `sonnet` |

各エージェントは **WebSearch で検索し、結果を構造化フォーマットで返却する**。WebFetch はこのステップでは行わない（Step 4 で一括取得）。

返却フォーマット: [references/agent-prompts.md](references/agent-prompts.md) の Search Agent セクション参照。

`--focus` 指定時は該当カテゴリのみ検索し、その分さらに深掘りする（検索クエリ数を倍増）。

検索クエリ・信頼ソースティア: [references/search-queries.md](references/search-queries.md)

## Step 3: Depth Filter + URL 重複排除

親 Opus が Step 2 の結果を集約し：
1. **Depth Filter**: 薄い情報を除外（Depth Filter 基準に従う）
2. **URL 重複排除**: 複数カテゴリから返された同一 URL を統合し、フェッチ対象リストを生成

## Step 4: 詳細取得（model: haiku）

重複排除済み URL リストに対して WebFetch を実行。各カテゴリ 3-5 件、合計で最大20件程度。

Agent(model: "haiku") で並列フェッチし、**URL・タイトル・関連部分の引用のみ**を構造化返却する。要約や分析は行わない。

## Step 5: Fact Check & Implementation（並列エージェント）

Step 4 の結果が揃ったら、2つの Agent を**並列で**起動する。**両方とも `model: "opus"`** を指定。

| Agent | Model | 目的 | やること |
|-------|-------|------|---------|
| Fact Check | `opus` | 情報の正確性検証 | `openai/codex` GitHub CHANGELOG、公式ドキュメント、実際の `config.toml` schema、CLI `--help` 出力と照合 |
| Implementation | `opus` | 実装例の構築 | 収集した tips から再現可能な TOML 設定例・headless スクリプト・GitHub Action workflow を構築。動作確認可能なレベルまで具体化 |

Implementation Agent は「概念の説明」ではなく「コピペで使える設定」を目指す。

プロンプト例: [references/agent-prompts.md](references/agent-prompts.md)

## Step 6: Rank & Format

ランキング基準（上が高い）:
1. **即座に使える**: コピペで `~/.codex/config.toml` に追加できる設定
2. **再現可能**: 手順に従えば構築できるワークフロー（headless / GitHub Action）
3. **計測済み**: before/after の数値がある最適化（latency / cost）
4. **知見**: 内部挙動の理解を深める情報（sandbox 制限、approval 内部仕様）

出力テンプレート: [references/output-template.md](references/output-template.md)

### 出力ルール

- 各 tip は必ず「TOML 設定例 or CLI 例 or スクリプト例」を含む
- 「〜が重要です」「〜を検討しましょう」で終わる tips は除外
- 情報がなかったカテゴリは「該当する新規 tips なし」と明記（無理にコンテンツを埋めない）
- 日本語で出力。固有名詞・技術用語・コード例は原語のまま

## Subagent Dispatch Rules

codex-tips は Step 2（6 カテゴリ並列検索）、Step 4（詳細取得）、Step 5（Fact Check / Implementation）で `Agent` tool 経由で subagent を複数起動するため、[Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) を遵守する。各 Agent 呼び出し時のプロンプトには以下5要素を必ず含める：

### Step 2: Deep Search Agent（6 カテゴリ並列、haiku/sonnet）

1. **Objective** — 「指定カテゴリ（A: Config / B: MCP / C: Performance / D: Workflow / E: Plugins / F: Undocumented）について直近 `$DAYS` 日の Codex CLI 上級者向け tips を WebSearch で収集し、Depth Filter 基準を満たす候補を返す」
2. **Output format** — `{ category, results: [{ title, url, source_tier, published_at, depth_score: 1-5, snippet }] }` JSON。1 カテゴリあたり上位 15 件まで。
3. **Tools** — 使用可: WebSearch のみ。禁止: WebFetch、Write、Edit、Bash
4. **Boundary** — 該当カテゴリの検索のみ、基本操作・インストール記事は除外、ローカルファイル触らない、commit 禁止
5. **Token cap** — 1000 語以内、検索クエリ最大 8 本

### Step 4: Fetch Agent（model: haiku）

1. **Objective** — 「重複排除済み URL リストを WebFetch で取得し、タイトル・関連部分の引用のみを返す」（要約・分析禁止）
2. **Output format** — `[{ url, title, excerpts: [string], code_blocks: [string] }]` JSON
3. **Tools** — 使用可: WebFetch のみ。禁止: WebSearch, Write, Edit, Bash
4. **Boundary** — 渡された URL 以外を辿らない、リンク先の追跡禁止、ローカルファイル書き込み禁止
5. **Token cap** — 1 URL あたり引用 300 語以内、1 Agent あたり最大 10 URL

### Step 5: Fact Check Agent（model: opus）

1. **Objective** — 「収集した tips の TOML キー・CLI フラグ・schema を `openai/codex` GitHub CHANGELOG / 公式 docs / `codex --help` と照合し、誤情報を検出する」
2. **Output format** — `{ verified: [{ claim, source_url, status }], errors: [{ claim, reason }] }` JSON
3. **Tools** — 使用可: WebFetch, Read。禁止: Write, Edit, Bash, WebSearch
4. **Boundary** — 事実照合のみ、新規検索禁止、ローカル設定ファイル書き込み禁止
5. **Token cap** — 1500 語以内、照合対象 claim は最大 25 件

### Step 5: Implementation Agent（model: opus）

1. **Objective** — 「収集 tips から `config.toml` / `[[mcp_servers]]` / `codex exec` ラッパースクリプト / GitHub Action workflow など、コピペで動作する実装例を構築する」
2. **Output format** — Markdown `## <tip title>\n```toml ... ```\n検証方法: ...` 形式。各 tip は実行可能な設定例を含む。
3. **Tools** — 使用可: Read（既存 `~/.codex/config.toml` 参照可）。禁止: Write, Edit, Bash, WebSearch, WebFetch
4. **Boundary** — ユーザーの実 `~/.codex/config.toml` を書き換えない、新規検索禁止、副作用禁止
5. **Token cap** — 2500 語以内、tip 数最大 10 本

**Routing**: Search は `haiku`（A-D）/ `sonnet`（E-F）、Fetch は `haiku`、Fact Check / Implementation は `opus`（`general-purpose` 系）。

## References

- [references/search-queries.md](references/search-queries.md) - 検索クエリ例・ソース信頼度ティア
- [references/agent-prompts.md](references/agent-prompts.md) - Search / Fetch / Fact Check / Implementation エージェントのプロンプト
- [references/output-template.md](references/output-template.md) - 出力 Markdown テンプレート
- [Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) - Subagent 呼び出し必須5要素と routing rule

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log codex-tips success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log codex-tips failure \
  --error-category <category> --error-msg "<message>"
```
