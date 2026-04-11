---
name: claude-code-tips
description: |
  Claude Code の上級者向け tips・tricks・設定パターン・内部挙動をWeb検索で収集し、
  実践的なコード例付きの構造化 Markdown を生成する。初心者向けの基本操作は一切含まない。
  Use when: (1) Claude Code の最新 tips やベストプラクティスを深掘りしたい,
  (2) hooks/MCP/settings.json/permissions/worktree 等の高度な設定パターンを知りたい,
  (3) Claude Code のパフォーマンスチューニングやコスト最適化を調べたい,
  (4) 他の上級者がどう使っているか実践例を収集したい,
  (5) keywords: CC tips, Claude Code tips, hooks設計, MCP設定, settings.json, ワークフロー最適化,
  パフォーマンス, コスト削減, 上級者向け, deep dive, power user, harness design
  Accepts args: [--focus hooks|mcp|performance|workflow|settings|all] [--days N] [--output PATH]
allowed-tools:
  - WebSearch
  - WebFetch
  - Bash
  - Read
  - Write
  - Agent
---

# Claude Code Tips (Deep Dive)

Claude Code の上級者向け tips を Web 検索で収集し、Fact Check・実装例付きの構造化 Markdown を生成する。

**対象**: hooks、MCP、settings.json、permissions、worktree、パフォーマンス、コスト最適化、ハーネス設計、CI/CD 統合など。
**除外**: 基本操作（インストール、初回セットアップ、`/help` の使い方等）は収集しない。

## Usage

```
/claude-code-tips [--focus hooks|mcp|performance|workflow|settings|all] [--days 14] [--output ./claudedocs/]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--focus` | `all` | 特定領域に絞る。`hooks`: hook 設計パターン, `mcp`: MCP サーバー統合, `performance`: トークン・速度最適化, `workflow`: 開発フロー・worktree・並列エージェント, `settings`: settings.json・permissions・CLAUDE.md 設計 |
| `--days` | `14` | 遡る日数（tips は鮮度より深さ重視のため ai-news-digest より長め） |
| `--output` | `./claudedocs/` | 出力先ディレクトリ |

## Depth Filter（重要）

収集した情報は以下の基準でフィルタリングする。通過しないものは出力に含めない。

| 含める | 除外する |
|--------|----------|
| settings.json の具体的な JSON 設定例 | 「Claude Code は便利です」系の感想記事 |
| hooks の実装パターンとユースケース | インストール手順・基本コマンド紹介 |
| MCP サーバーの接続設定・活用例 | 公式ドキュメントのそのままコピー |
| パフォーマンス計測値・最適化手法 | 「AI コーディングの未来」系の展望記事 |
| worktree/並列エージェントの実践フロー | 他ツール（Cursor, Copilot）との比較記事 |
| CLAUDE.md/AGENTS.md の設計パターン | バージョン番号の羅列だけのリリースノート |
| CI/CD・ヘッドレス運用の実装例 | 一般的なプロンプトエンジニアリング論 |
| 環境変数・隠し機能・undocumented features | |

## Model Strategy

処理フェーズごとにモデルを分離し、コスト効率を最適化する。

| Phase | Model | 理由 |
|-------|-------|------|
| Step 1: 調査設計（クエリ策定） | 親セッション (Opus) | 検索空間の設計で情報の質が決まる |
| Step 2: 検索・取得（A-D） | `model: "haiku"` | クエリ実行＋構造化返却のみ |
| Step 2: 検索・取得（E-F） | `model: "sonnet"` | 検索中の判断（未公開機能の評価等）が必要 |
| Step 3: URL 重複排除 | 親セッション (Opus) | 軽量処理、別エージェント不要 |
| Step 4: 詳細取得 | `model: "haiku"` | URL を fetch して生テキスト返却のみ |
| Step 5: Fact Check | `model: "opus"` | JSON キー・スキーマの厳密照合 |
| Step 5: Implementation | `model: "opus"` | コピペ可能な設定の創造的構築 |

## Workflow

```
Step 1: Parse args → 日付範囲計算、出力ファイル名: cc-tips-YYYY-MM-DD.md（親 Opus）
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
| A: Hooks & Events | PreToolUse, PostToolUse, Notification, PermissionDenied, Stop 等の hook パターン | 実装例、matcher 設計、hook 間連携 | `haiku` |
| B: MCP Integration | MCP サーバーの設定・自作・活用例 | transport 設定、認証、scopedPermissions | `haiku` |
| C: Performance & Cost | トークン削減、キャッシュ最適化、モデル選択 | 計測方法、具体的な数値、before/after | `haiku` |
| D: Workflow & Automation | worktree、並列エージェント、CI/CD、ヘッドレス運用 | 実践フロー、スクリプト例 | `haiku` |
| E: Harness Design | CLAUDE.md, AGENTS.md, settings.json, permissions の設計パターン | 構造設計、allowRules、スキル設計 | `sonnet` |
| F: Undocumented & Advanced | 環境変数、CLI フラグ、内部挙動、エッジケース | 公式ドキュメントに載っていない情報 | `sonnet` |

各エージェントは **WebSearch で検索し、結果を構造化フォーマットで返却する**。WebFetch はこのステップでは行わない（Step 4 で一括取得）。

返却フォーマット: [references/agent-prompts.md](references/agent-prompts.md) の Search Agent セクション参照。

`--focus` 指定時は該当カテゴリのみ検索し、その分さらに深掘りする（検索クエリ数を倍増）。

検索クエリ・信頼ソースティア: [references/search-queries.md](references/search-queries.md)

## Step 3: Depth Filter + URL 重複排除

親 Opus がStep 2 の結果を集約し：
1. **Depth Filter**: 薄い情報を除外（Depth Filter 基準に従う）
2. **URL 重複排除**: 複数カテゴリから返された同一 URL を統合し、フェッチ対象リストを生成

## Step 4: 詳細取得（model: haiku）

重複排除済み URL リストに対して WebFetch を実行。各カテゴリ 3-5 件、合計で最大20件程度。

Agent(model: "haiku") で並列フェッチし、**URL・タイトル・関連部分の引用のみ**を構造化返却する。要約や分析は行わない。

## Step 5: Fact Check & Implementation（並列エージェント）

Step 4 の結果が揃ったら、2つの Agent を**並列で**起動する。**両方とも `model: "opus"`** を指定。

| Agent | Model | 目的 | やること |
|-------|-------|------|---------|
| Fact Check | `opus` | 情報の正確性検証 | GitHub CHANGELOG、公式ドキュメント、実際の settings schema と照合 |
| Implementation | `opus` | 実装例の構築 | 収集した tips から再現可能な設定例・スクリプトを構築。動作確認可能なレベルまで具体化 |

Implementation Agent は「概念の説明」ではなく「コピペで使える設定」を目指す。

プロンプト例: [references/agent-prompts.md](references/agent-prompts.md)

## Step 6: Rank & Format

ランキング基準（上が高い）:
1. **即座に使える**: コピペで settings.json に追加できる設定
2. **再現可能**: 手順に従えば構築できるワークフロー
3. **計測済み**: before/after の数値がある最適化
4. **知見**: 内部挙動の理解を深める情報

出力テンプレート: [references/output-template.md](references/output-template.md)

### 出力ルール

- 各 tip は必ず「設定例 or コマンド例 or スクリプト例」を含む
- 「〜が重要です」「〜を検討しましょう」で終わる tips は除外
- 情報がなかったカテゴリは「該当する新規 tips なし」と明記（無理にコンテンツを埋めない）
- 日本語で出力。固有名詞・技術用語・コード例は原語のまま

## Subagent Dispatch Rules

claude-code-tips は Step 2（6 カテゴリ並列検索）、Step 4（詳細取得）、Step 5（Fact Check / Implementation）で `Agent` tool 経由で subagent を複数起動するため、[Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) を遵守する。各 Agent 呼び出し時のプロンプトには以下5要素を必ず含める：

### Step 2: Deep Search Agent（6 カテゴリ並列、haiku/sonnet）

1. **Objective** — 「指定カテゴリ（A: Hooks / B: MCP / C: Performance / D: Workflow / E: Harness / F: Undocumented）について直近 `$DAYS` 日の上級者向け tips を WebSearch で収集し、Depth Filter 基準を満たす候補を返す」
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

1. **Objective** — 「収集した tips の JSON キー・コマンド名・schema を GitHub CHANGELOG / 公式 schema と照合し、誤情報を検出する」
2. **Output format** — `{ verified: [{ claim, source_url, status }], errors: [{ claim, reason }] }` JSON
3. **Tools** — 使用可: WebFetch, Read。禁止: Write, Edit, Bash, WebSearch
4. **Boundary** — 事実照合のみ、新規検索禁止、ローカル設定ファイル書き込み禁止
5. **Token cap** — 1500 語以内、照合対象 claim は最大 25 件

### Step 5: Implementation Agent（model: opus）

1. **Objective** — 「収集 tips から `settings.json` / hook スクリプト / MCP 設定など、コピペで動作する実装例を構築する」
2. **Output format** — Markdown `## <tip title>\n```json ... ```\n検証方法: ...` 形式。各 tip は実行可能な設定例を含む。
3. **Tools** — 使用可: Read（既存 settings.json 参照可）。禁止: Write, Edit, Bash, WebSearch, WebFetch
4. **Boundary** — ユーザーの実 `settings.json` を書き換えない、新規検索禁止、副作用禁止
5. **Token cap** — 2500 語以内、tip 数最大 10 本

**Routing**: Search は `haiku`（A-D）/ `sonnet`（E-F）、Fetch は `haiku`、Fact Check / Implementation は `opus`（`general-purpose` 系）。

## References

- [references/search-queries.md](references/search-queries.md) - 検索クエリ例・ソース信頼度ティア
- [references/agent-prompts.md](references/agent-prompts.md) - Fact Check / Implementation エージェントのプロンプト
- [references/output-template.md](references/output-template.md) - 出力 Markdown テンプレート
- [Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) - Subagent 呼び出し必須5要素と routing rule

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log claude-code-tips success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log claude-code-tips failure \
  --error-category <category> --error-msg "<message>"
```
