---
name: ai-pulse
description: |
  AI キャッチアップガイドが定める Tier A 固定ソース（Smol AI News, Simon Willison,
  Latent Space, HuggingFace Daily Papers）を横断取得し、1 枚の Markdown に集約する
  日次ダイジェスト。ai-news-digest がトピック駆動なのに対し、本 skill は claudedocs/
  ai-catchup-guide.md が定める「読むべきソース」を起点とするソース駆動。
  Use when: (1) 毎日の AI 情報キャッチアップを 1 ファイルで完結させたい,
  (2) Smol AI News / Simon Willison / Latent Space / HF Daily Papers の最新を横断したい,
  (3) ガイドの「毎朝 10 分」ルーティンを実行したい,
  (4) keywords: AI 日次, daily brief, AI pulse, ソース横断, info diet,
  毎朝のAI, Smol AI News, Simon Willison, Latent Space, HF Daily Papers
  Accepts args: [--days N] [--output PATH] [--sources LIST]
allowed-tools:
  - WebFetch
  - WebSearch
  - Bash
  - Read
  - Write
  - Agent
---

# AI Pulse (Daily Source Digest)

AI キャッチアップガイドの Tier A 固定ソースを横断取得し、1 枚の Markdown に集約する日次ダイジェスト。

**目的**: 「サイトを 4 つ巡回する」を「1 ファイルを読む」に置き換える。
**非目的**: 検索ベースの広範な調査（→ `/ai-news-digest`）、特定領域の深掘り tips（→ `/claude-code-tips`, `/codex-tips`）。

## Usage

```
/ai-pulse [--days 1] [--output ./claudedocs/pulse/] [--sources all]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--days` | `1` | 遡る日数。週次まとめなら `--days 7` |
| `--output` | `./claudedocs/pulse/` | 出力先ディレクトリ。`pulse-YYYY-MM-DD.md` で保存 |
| `--sources` | `all` | `smol,willison,latent,hfpapers` のカンマ区切り。`all` で 4 ソース全部 |

### Source ID

| ID | サイト | URL | 取得対象 |
|----|--------|-----|---------|
| `smol` | Smol AI News | `https://buttondown.com/ainews` | 最新エディション |
| `willison` | Simon Willison's Weblog | `https://simonwillison.net/` | 直近 `--days` 日の記事 |
| `latent` | Latent Space | `https://www.latent.space/` | 直近 `--days` 日の記事 |
| `hfpapers` | HuggingFace Daily Papers | `https://huggingface.co/papers` | 当日分の TL;DR |

## Workflow

```
Step 1: Parse args → 出力 path / 取得対象ソース確定
Step 2: 4 ソースを Agent で並列 fetch + 各記事 3 行要約
Step 3: カテゴリ分類 (Claude Code / 新モデル / Eval / プロンプティング / その他)
Step 4: 「今日触るべき 1 つ」を 1 件ピック（ハンズオン誘導枠）
Step 5: MD format → Save → ファイルパス表示
```

## Step 1: Parse Args

`scripts/parse-args.sh` で引数を解釈し、以下を出力する:

- 出力 file path: `<output_dir>/pulse-YYYY-MM-DD.md` (today base)
- 取得対象 source ID リスト

`--sources all` 指定時は 4 ソース全部、それ以外はカンマ区切りで指定された ID のみ。

## Step 2: Parallel Fetch & Summarize（4 ソース × Agent）

各ソースに対して 1 つの subagent を並列で dispatch する。

各 agent は:
1. ソースの URL を WebFetch（必要なら index → individual articles）
2. `--days` 範囲内の記事を抽出
3. 各記事を 3 行要約 に圧縮（1行目: 何が起きたか / 2行目: 開発者への影響 / 3行目: ソース URL）
4. 結果を JSON 配列で返す

詳細プロンプト: [references/agent-prompts.md](references/agent-prompts.md)

## Step 3: Categorize

Step 2 の全記事を以下のカテゴリにバケット分けする（重複可）:

| カテゴリ | 含むもの |
|---------|---------|
| Claude Code / Anthropic | CC 更新、Claude API、Anthropic ブログ |
| 新モデル / リリース | GPT/Gemini/Claude/オープンソース新モデル、新製品 |
| Eval / LLMOps | 評価、observability、本番運用 |
| プロンプティング / 技法 | プロンプトエンジニアリング、推論技法 |
| 論文 / 研究 | HF Papers、arXiv 関連 |
| その他 | 上記に当てはまらないもの |

該当記事が 0 件のカテゴリは「特筆なし」と明記し、空セクションを残さない。

## Step 4: 「今日触るべき 1 つ」をピック

ガイド §0 の大原則「読む量より触る量」を守るため、出力に必ず以下のセクションを含める:

```markdown
## 今日触るべき 1 つ

- 対象: <ツール名 / モデル名 / コードリポジトリ名>
- 理由: <なぜ今日触る価値があるか 1 行>
- 最初のコマンド: `<実行コマンドや URL>`
```

選定基準（優先順）:
1. 試せるもの: 今日叩けるコマンドが存在する（CLI install、Playground、Colab notebook 等）
2. 5–15 分で結果が出る: 環境構築だけで終わるものは選ばない
3. 既存業務と接続できる: Claude Code / Mastra / Vercel 系ワークフローに乗りそうなもの

該当なしの日は「今日は『触る』より『読む』日。気になった記事を 1 本だけ精読する」と明記。

## Step 5: Format & Save

出力テンプレ: [references/output-template.md](references/output-template.md)

- ファイル名: `pulse-YYYY-MM-DD.md`
- 出力先: `--output` で指定（デフォルト `./claudedocs/pulse/`）
- 既に同名ファイルがあれば末尾に `-2`, `-3` を付与
- 保存後、絶対パスをユーザーに表示

## Subagent Dispatch Rules

この skill は Step 2 で 4 ソース × Agent を並列起動する。
[Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) を遵守し、各呼び出しで以下 5 要素を明示する:

1. **Objective** — `<source>` から直近 N 日の記事を 3 行要約に圧縮して JSON 配列で返す
2. **Output format** — `[{title, url, published, summary_3lines, category_hint}]` の JSON のみ
3. **Tools** — WebFetch のみ可。Write / Edit / Bash 禁止
4. **Boundary** — リポジトリのファイル変更禁止、外部 POST 禁止、認証必要なサイトはスキップ
5. **Token cap** — 1 ソースあたり最大 8 記事、要約は各 3 行・各行 80 字以内

**Routing**: 探索 heavy なので `general-purpose` / Haiku で十分。Opus は不要。

| タスク性質 | 推奨 subagent | model |
|-----------|--------------|-------|
| 各ソースの記事取得＋要約 | `general-purpose` | haiku |

## Journal Logging

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log ai-pulse success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log ai-pulse failure \
  --error-category <category> --error-msg "<message>"
```

## References

- [output-template.md](references/output-template.md) - 出力 Markdown テンプレート
- [agent-prompts.md](references/agent-prompts.md) - 各ソース fetch agent のプロンプト
- [Skill Creation Guide](../docs/skill-creation-guide.md) - canonical source
