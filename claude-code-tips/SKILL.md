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

## Workflow

```
Step 1: Parse args → 日付範囲計算、出力ファイル名: cc-tips-YYYY-MM-DD.md
Step 2: Parallel deep search (6 categories × Agent)
Step 3: Depth filter → 薄い情報を除外
Step 4: WebFetch で上位ソースから詳細取得（各カテゴリ 3-5 件）
Step 5: Fact Check Agent + Implementation Agent (並列)
Step 6: Deduplicate, rank by actionability → Format MD → Save
```

## Step 2: Parallel Deep Search

Agent ツールで6カテゴリを**並列**検索する。各エージェントは WebSearch + WebFetch で深掘りする。

| Category | 内容 | 深掘りポイント |
|----------|------|---------------|
| A: Hooks & Events | PreToolUse, PostToolUse, Notification, PermissionDenied, Stop 等の hook パターン | 実装例、matcher 設計、hook 間連携 |
| B: MCP Integration | MCP サーバーの設定・自作・活用例 | transport 設定、認証、scopedPermissions |
| C: Performance & Cost | トークン削減、キャッシュ最適化、モデル選択 | 計測方法、具体的な数値、before/after |
| D: Workflow & Automation | worktree、並列エージェント、CI/CD、ヘッドレス運用 | 実践フロー、スクリプト例 |
| E: Harness Design | CLAUDE.md, AGENTS.md, settings.json, permissions の設計パターン | 構造設計、allowRules、スキル設計 |
| F: Undocumented & Advanced | 環境変数、CLI フラグ、内部挙動、エッジケース | 公式ドキュメントに載っていない情報 |

`--focus` 指定時は該当カテゴリのみ検索し、その分さらに深掘りする（検索クエリ数を倍増）。

検索クエリ・信頼ソースティア: [references/search-queries.md](references/search-queries.md)

## Step 5: Fact Check & Implementation（並列エージェント）

Step 2-4 の結果が揃ったら、2つの Agent を**並列で**起動する。

| Agent | 目的 | やること |
|-------|------|---------|
| Fact Check | 情報の正確性検証 | GitHub CHANGELOG、公式ドキュメント、実際の settings schema と照合 |
| Implementation | 実装例の構築 | 収集した tips から再現可能な設定例・スクリプトを構築。動作確認可能なレベルまで具体化 |

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

## References

- [references/search-queries.md](references/search-queries.md) - 検索クエリ例・ソース信頼度ティア
- [references/agent-prompts.md](references/agent-prompts.md) - Fact Check / Implementation エージェントのプロンプト
- [references/output-template.md](references/output-template.md) - 出力 Markdown テンプレート

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
