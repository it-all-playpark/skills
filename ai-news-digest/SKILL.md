---
name: ai-news-digest
description: |
  AI（特にClaude Code）の最新情報・tips・アップデートをWeb検索で収集し、構造化ダイジェストとしてMarkdown保存する。
  Use when: (1) AIの最新ニュースやアップデートを知りたい,
  (2) Claude Codeの新機能・tips・変更点をキャッチアップしたい,
  (3) LLM業界の直近トレンドをまとめたい,
  (4) keywords: AI最新情報, AIニュース, Claude Code更新, LLMトレンド, tips, アップデート, キャッチアップ, 今週のAI, what's new
  Accepts args: [--scope claude-code|claude|ai-all] [--days N] [--output PATH]
allowed-tools:
  - WebSearch
  - WebFetch
  - Bash
  - Read
  - Write
  - Agent
---

# AI News Digest

AI の最新情報を Web 検索で収集し、Fact Check・実践 Tips 付きの構造化 Markdown を生成する。

## Usage

```
/ai-news-digest [--scope claude-code|claude|ai-all] [--days 7] [--output ./claudedocs/]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--scope` | `ai-all` | `claude-code`: CC特化, `claude`: Claude全般, `ai-all`: AI業界全体 |
| `--days` | `7` | 遡る日数 |
| `--output` | `./claudedocs/` | 出力先ディレクトリ |

## Workflow

```
Step 1: Parse args → 日付範囲計算、出力ファイル名: ai-digest-YYYY-MM-DD.md
Step 2: Parallel search (4 categories × Agent)
Step 3: Fetch key details (WebFetch、各カテゴリ上位3-5件)
Step 4: Fact Check Agent + Practical Tips Agent (並列)
Step 5: Deduplicate & rank
Step 6: Format MD → Save
```

## Step 2: Parallel Search

Agent ツールで4カテゴリを**並列**検索する。各エージェントは WebSearch で直近の情報に絞る。

| Category | 内容 |
|----------|------|
| A: Claude Code | CC の更新・tips。開発者の実用情報最優先 |
| B: Claude API / Models | モデル・API 更新、新機能、料金変更 |
| C: LLM / AI Industry | 競合含む業界主要ニュース |
| D: Tips & Best Practices | ハーネス設計（CLAUDE.md, hooks, MCP等）、開発ワークフロー |

検索クエリ・信頼ソースティア: [references/search-queries.md](references/search-queries.md)

## Step 4: Fact Check & Practical Tips（並列エージェント）

Step 2-3 の結果が揃ったら、2つの Agent を**並列で**起動する。

| Agent | 目的 | 出力先 |
|-------|------|--------|
| Fact Check | 公式ソース（CHANGELOG, Release Notes）と照合 | Fact Check セクション |
| Practical Tips | 新機能の settings.json 設定例・コマンド例・ユースケース収集 | Tips セクション |

Tips は一般論ではなく「この JSON を追加すると Y ができる」レベルの具体性を目指す。

プロンプト例: [references/agent-prompts.md](references/agent-prompts.md)

## Step 5: Deduplicate & Rank

- 同一ニュースは最も信頼性の高いソースに統合
- 重要度順: 公式発表 > 大きな機能追加 > Tips > 小さな修正

## Step 6: Format & Save

各項目は「**要約 + ソースリンク + 影響**」の3点セットで構成する。

出力テンプレート: [references/output-template.md](references/output-template.md)

### 出力ルール

- 情報がなかったカテゴリは「特筆すべき更新なし」と明記
- `--scope` で絞った場合、対象外カテゴリは省略
- 日本語で出力。固有名詞・技術用語は原語のまま

## References

- [references/search-queries.md](references/search-queries.md) - 検索クエリ例・ソース信頼度ティア
- [references/agent-prompts.md](references/agent-prompts.md) - Fact Check / Tips エージェントのプロンプト
- [references/output-template.md](references/output-template.md) - 出力 Markdown テンプレート
