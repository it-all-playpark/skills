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
  - Read
  - Write
  - Agent
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
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
| `--output` | `./claudedocs/` | 出力先ディレクトリ（`skill-config.json` の `output_dir` で上書き可） |

## Config

プロジェクトの `skill-config.json`（ルートまたは `.claude/`）に `ai-news-digest.output_dir` があれば `--output` のデフォルト値として使用する。`--output` 引数が明示的に渡された場合はそちらを優先。

```jsonc
// .claude/skill-config.json
{
  "ai-news-digest": {
    "output_dir": "news"   // → ai-digest-YYYY-MM-DD.md を news/ に出力
  }
}
```

解決順序: `--output` 引数 > `skill-config.json` > デフォルト (`./claudedocs/`)

## Model Strategy

処理フェーズごとにモデルを分離し、コスト効率を最適化する。

| Phase | Model | 理由 |
|-------|-------|------|
| Step 1: 調査設計（クエリ策定） | 親セッション (Opus) | 検索空間の設計で情報の質が決まる |
| Step 2: 検索（全カテゴリ） | `model: "haiku"` | クエリ実行＋構造化返却のみ |
| Step 3: URL 重複排除 | 親セッション (Opus) | 軽量処理、別エージェント不要 |
| Step 4: 詳細取得 | `model: "haiku"` | URL を fetch して生テキスト返却のみ |
| Step 5: Fact Check | `model: "sonnet"` | 日付・バージョン照合は機械的 |
| Step 5: Practical Tips | `model: "opus"` | 具体的な設定例の創造的構築 |

## Workflow

```
Step 1: Parse args → skill-config.json 読込 → 日付範囲計算、出力ファイル名: ai-digest-YYYY-MM-DD.md（親 Opus）
Step 2: Parallel search (4 categories × Agent, model: haiku)
Step 3: URL 重複排除 + フィルタ（親 Opus）
Step 4: Fetch key details (WebFetch、重複排除済み URL、model: haiku)
Step 5: Fact Check Agent (model: sonnet) + Practical Tips Agent (model: opus)（並列）
Step 6: Deduplicate & rank（親 Opus）
Step 7: Format MD → Save
```

## Step 2: Parallel Search

Agent ツールで4カテゴリを**並列**検索する。全カテゴリ `model: "haiku"` で起動。

各エージェントは WebSearch で直近の情報に絞り、**構造化フォーマットで結果を返却する**。WebFetch はこのステップでは行わない。

| Category | 内容 | Model |
|----------|------|-------|
| A: Claude Code | CC の更新・tips。開発者の実用情報最優先 | `haiku` |
| B: Claude API / Models | モデル・API 更新、新機能、料金変更 | `haiku` |
| C: LLM / AI Industry | 競合含む業界主要ニュース | `haiku` |
| D: Tips & Best Practices | ハーネス設計（CLAUDE.md, hooks, MCP等）、開発ワークフロー | `haiku` |

返却フォーマット: [references/agent-prompts.md](references/agent-prompts.md) の Search Agent セクション参照。

検索クエリ・信頼ソースティア: [references/search-queries.md](references/search-queries.md)

## Step 3: URL 重複排除 + フィルタ

親 Opus が Step 2 の結果を集約し：
1. 複数カテゴリから返された同一 URL を統合
2. Tier 4 で裏付けなしの情報を除外
3. フェッチ対象 URL リストを生成（各カテゴリ 3-5 件）

## Step 4: 詳細取得（model: haiku）

重複排除済み URL リストに対して WebFetch を実行。Agent(model: "haiku") で並列フェッチし、**URL・タイトル・関連引用のみ**を返却する。

## Step 5: Fact Check & Practical Tips（並列エージェント）

Step 4 の結果が揃ったら、2つの Agent を**並列で**起動する。

| Agent | Model | 目的 | 出力先 |
|-------|-------|------|--------|
| Fact Check | `sonnet` | 公式ソース（CHANGELOG, Release Notes）と照合。日付・バージョンの機械的照合 | Fact Check セクション |
| Practical Tips | `opus` | 新機能の settings.json 設定例・コマンド例・ユースケースの創造的構築 | Tips セクション |

Tips は一般論ではなく「この JSON を追加すると Y ができる」レベルの具体性を目指す。

プロンプト例: [references/agent-prompts.md](references/agent-prompts.md)

## Step 6: Deduplicate & Rank

- 同一ニュースは最も信頼性の高いソースに統合
- 重要度順: 公式発表 > 大きな機能追加 > Tips > 小さな修正

## Step 6: Format & Save

各項目は「**要約 + ソースリンク + 影響**」の3点セットで構成する。

出力テンプレート: [references/output-template.md](references/output-template.md)

### 出力ルール

- 情報がなかったカテゴリは「特筆すべき更新なし」と明記
- `--scope` で絞った場合、対象外カテゴリは省略
- 日本語で出力。固有名詞・技術用語は原語のまま

## Subagent Dispatch Rules

ai-news-digest は Step 2（並列検索）、Step 4（詳細取得）、Step 5（Fact Check / Practical Tips）で `Agent` tool 経由で subagent を複数起動するため、[Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) を遵守する。各 Agent 呼び出し時のプロンプトには以下5要素を必ず含める：

### Step 2: Search Agent（4 カテゴリ並列）

1. **Objective** — 「指定カテゴリ（A/B/C/D）について、直近 `$DAYS` 日の AI 関連情報を WebSearch で収集し、構造化リストを返す」（単一カテゴリを 1 Agent が担当）
2. **Output format** — `{ category, results: [{ title, url, source_tier, published_at, one_line_summary }] }` JSON。上位 10 件まで。
3. **Tools** — 使用可: WebSearch のみ。禁止: WebFetch（Step 4 で一括取得）、Write、Edit、Bash
4. **Boundary** — 対象カテゴリの検索のみ、ローカルファイル触らない、コミット・ネットワーク書き込み禁止
5. **Token cap** — 800 語以内、検索クエリ最大 6 本

### Step 4: Fetch Agent（model: haiku）

1. **Objective** — 「与えられた URL リストを WebFetch で取得し、タイトル・関連引用・公開日のみ返す」（生テキストの抽出のみ）
2. **Output format** — `[{ url, title, published_at, excerpts: [string] }]` JSON
3. **Tools** — 使用可: WebFetch のみ。禁止: WebSearch、Write、Edit、Bash
4. **Boundary** — 渡された URL 以外を辿らない、要約・分析・意見付与禁止、ローカルファイル触らない
5. **Token cap** — 1 URL あたり引用 200 語以内、1 Agent あたり最大 10 URL

### Step 5: Fact Check Agent（model: sonnet）

1. **Objective** — 「Step 4 の抽出結果に含まれる日付・バージョン・API 仕様を公式ソース（CHANGELOG / Release Notes）と照合し、矛盾点を列挙する」
2. **Output format** — `{ verified: [{ claim, source_url, status: "confirmed"|"contradicted"|"unverifiable" }], contradictions: [...] }` JSON
3. **Tools** — 使用可: WebFetch, Read。禁止: Write, Edit, Bash, WebSearch（新規検索はしない）
4. **Boundary** — 事実照合のみ、新規情報探索禁止、ローカルファイル書き込み禁止
5. **Token cap** — 1200 語以内、照合対象 claim は最大 20 件

### Step 5: Practical Tips Agent（model: opus）

1. **Objective** — 「収集情報から `settings.json` / コマンド / ワークフローの具体例を構築し、即コピペ可能な Tips 集を返す」
2. **Output format** — Markdown セクション `## Tips\n- ### <title>\n  ```json ... ```\n  影響: ...` 形式。各 Tip は設定例を必ず含む。
3. **Tools** — 使用可: Read（既存テンプレート参照）。禁止: Write, Edit, Bash, WebSearch, WebFetch
4. **Boundary** — 新規情報探索禁止、既存設定ファイルの破壊的変更禁止、親セッションの状態に依存しない
5. **Token cap** — 2000 語以内、Tips 最大 8 本

**Routing**: Search / Fetch は `haiku`、Fact Check は `sonnet`、Practical Tips は `opus`（`general-purpose` 系）。

## References

- [references/search-queries.md](references/search-queries.md) - 検索クエリ例・ソース信頼度ティア
- [references/agent-prompts.md](references/agent-prompts.md) - Fact Check / Tips エージェントのプロンプト
- [references/output-template.md](references/output-template.md) - 出力 Markdown テンプレート
- [Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) - Subagent 呼び出し必須5要素と routing rule

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log ai-news-digest success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log ai-news-digest failure \
  --error-category <category> --error-msg "<message>"
```
