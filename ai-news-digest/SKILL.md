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

AI の最新情報を Web 検索で収集し、カテゴリ別に構造化した Markdown ダイジェストを生成する。

## Usage

```
/ai-news-digest [--scope claude-code|claude|ai-all] [--days 7] [--output ./claudedocs/]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--scope` | `ai-all` | 収集範囲。`claude-code`: CC特化, `claude`: Claude全般, `ai-all`: AI業界全体 |
| `--days` | `7` | 遡る日数 |
| `--output` | `./claudedocs/` | 出力先ディレクトリ |

## Workflow

```
Step 1: Parse args
Step 2: Parallel search (4 categories × Agent)
Step 3: Fetch key details (WebFetch)
Step 4: Fact Check Agent + Practical Tips Agent (並列)
Step 5: Deduplicate & rank
Step 6: Format MD → Save
```

## Step 1: Parse Args & Prepare

引数をパースし、デフォルト値を適用する。日付範囲を計算する（今日から `--days` 日前まで）。

出力ファイル名: `ai-digest-YYYY-MM-DD.md`

## Step 2: Parallel Search

Agent ツールで4カテゴリを**並列**検索する。各エージェントは WebSearch を使い、直近の情報に絞る。

### Category A: Claude Code

Claude Code に特化した更新・tips を探す。開発者の実用情報が最優先。

検索クエリ例:
- `"Claude Code" new feature OR update OR release (この1週間)`
- `"Claude Code" tips OR tricks OR workflow site:github.com OR site:x.com`
- `anthropics/claude-code releases` (GitHub)
- `site:docs.anthropic.com Claude Code changelog`

### Category B: Claude API / Models

Claude モデル・API の更新、新機能、料金変更など。

検索クエリ例:
- `Anthropic Claude API update OR release OR announcement (この1週間)`
- `Claude Sonnet OR Opus OR Haiku new (この1週間)`
- `site:docs.anthropic.com changelog OR release-notes`

### Category C: LLM / AI Industry

競合含む AI 業界の主要ニュース。信頼性の高いソースを優先。

検索クエリ例:
- `LLM AI news (この1週間) site:techcrunch.com OR site:theverge.com OR site:arstechnica.com`
- `OpenAI OR Google Gemini OR Meta Llama announcement (この1週間)`
- `AI developer tools update (この1週間)`

### Category D: Tips & Best Practices

実践的なテクニック、ワークフロー改善、ベストプラクティス。

検索クエリ例:
- `Claude Code tips OR best practices OR productivity (この1週間)`
- `AI coding assistant tips OR workflow (この1週間) site:dev.to OR site:medium.com OR site:zenn.dev`
- `LLM prompt engineering new technique (この1週間)`

### 信頼できるソース（優先順）

| Tier | Sources | 判断基準 |
|------|---------|----------|
| 1 (公式) | docs.anthropic.com, github.com/anthropics, anthropic.com/blog | 一次情報 |
| 2 (信頼メディア) | TechCrunch, The Verge, Ars Technica, Hacker News, The Information | 編集チームによる検証済み |
| 3 (開発者コミュニティ) | GitHub Discussions, dev.to, Zenn, Hacker News comments | 実践者の声 |
| 4 (SNS/個人) | X/Twitter, 個人ブログ | 速報性は高いが要検証 |

Tier 4 の情報は単独では採用せず、他ソースで裏付けがある場合のみ含める。

## Step 3: Fetch Key Details

検索結果のうち重要そうなページは WebFetch で詳細を取得する。各カテゴリ上位3-5件程度。

## Step 4: Fact Check & Practical Tips（並列エージェント）

Step 2-3 の結果が揃ったら、以下の2つの Agent を**並列で**起動する。

### Agent 1: Fact Check

収集した情報を公式ソースと照合する別エージェントを起動。

```
プロンプト例:
「以下の情報を公式ソースと照合し、各項目の正確性を検証してください。
 検証対象: [Step 2-3 で収集した主要項目のリスト]
 
 検証方法:
 - Claude Code: WebFetch で GitHub CHANGELOG / Releases を取得し照合
 - Claude API: WebFetch で docs.anthropic.com/release-notes を取得し照合
 - AI Industry: WebSearch で複数の信頼メディアに報じられているか確認
 
 各項目について「確認済み / 未確認 / 誤り」を判定し、誤りがあれば正しい情報を返してください。」
```

照合結果は Fact Check セクションとしてダイジェスト末尾に記載する。

### Agent 2: Practical Tips

Claude Code の新機能について、公式ドキュメントから**実際の設定例・コマンド例**を収集する別エージェントを起動。

```
プロンプト例:
「Claude Code の以下の新機能について、実践的な tips を調べてください。
 対象: [Step 2 で見つかった新機能リスト]
 
 各機能について:
 - settings.json の設定例（JSON コード）
 - bash コマンド例
 - 具体的なユースケース（「こういう場面で使える」）
 
 公式ドキュメント（code.claude.com/docs, github.com/anthropics）を最優先ソースとしてください。
 概論的な「XYZ が重要になった」は不要。「この JSON を settings.json に追加すると Y ができる」レベルの具体性で。」
```

Tips セクションには一般論ではなく、設定コード・コマンド例・ユースケースの3点セットで記載する。

## Step 5: Deduplicate & Rank

- 同じニュースが複数ソースに出ている場合は1つにまとめる（最も信頼性の高いソースを代表に）
- 重要度でソート: 公式発表 > 大きな機能追加 > Tips/テクニック > 小さな修正

## Step 5: Format & Save

以下のテンプレートで Markdown を生成し、指定パスに保存する。

```markdown
# AI Digest: YYYY-MM-DD

> 対象期間: YYYY-MM-DD 〜 YYYY-MM-DD
> Scope: ai-all

## Claude Code

重要度の高い順に記載。

### [見出し]
- **ソース**: [リンク](URL)
- **要約**: 2-3行の要約
- **影響**: 自分の開発フローにどう関係するか（1行）

---

## Claude API / Models

(同フォーマット)

---

## AI Industry

(同フォーマット)

---

## Tips & Techniques

(同フォーマット)

---

## Sources

収集に使用した全ソース URL のリスト。
```

### 出力ルール

- 各項目は「要約 + ソースリンク + 影響」の3点セットで構成する
- 情報がなかったカテゴリは「特筆すべき更新なし」と明記（セクション自体は残す）
- `--scope` で絞った場合、対象外カテゴリは省略する
- 日本語で出力する。固有名詞・技術用語は原語のまま
