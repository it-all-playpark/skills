---
name: blog-fact-check
description: |
  MDX記事内の統計データ・バージョン情報・料金等を抽出し、公式ソースと照合するファクトチェックスキル。
  Use when: 記事の事実確認、データ検証、料金チェック、バージョン確認が必要な時。
  Accepts args: [file-path] [--all] [--category statistics|pricing|versions|dates] [--fix]
context: fork
model: sonnet
---

# Blog Fact Check

MDX記事内のファクトチェックを実行する。

## Usage

```
/blog-fact-check <file-path>
/blog-fact-check --all
/blog-fact-check --category pricing
```

| Arg | Description |
|-----|-------------|
| file-path | チェック対象のMDXファイルパス |
| --all | 全記事をチェック |
| --category | チェック対象カテゴリ (statistics, pricing, versions, dates) |
| --fix | 不一致箇所を自動修正 |

## Config

skill-config.json の `blog-fact-check` セクションから設定を読み込む。

| Key | Default | Description |
|-----|---------|-------------|
| content_dir | content/blog | MDX記事ディレクトリ |
| check_targets | ["statistics", "pricing", "versions", "dates", "urls", "entities", "testimonials", "self_claims"] | チェック対象カテゴリ |
| auto_fix_categories | ["statistics", "pricing", "versions", "dates"] | `--fix` 時に自動置換するカテゴリ |
| review_only_categories | ["urls", "entities", "testimonials", "self_claims"] | `--fix` 時に flag のみで human review に回すカテゴリ (フィクションを別のフィクションに書き換えるリスク回避) |
| severity_threshold | warning | 報告レベル (error, warning, info) |
| output_dir | claudedocs | レポート出力先 |

## Workflow

```
1. Config読込 → 2. MDXパース → 3. Claim抽出 → 4. Web検索照合 → 5. レポート出力
```

### Step 1: Config読込

skill-config.json から設定を取得。CLI引数でオーバーライド可能。

### Step 2: MDXパース

対象ファイルを Read し、frontmatter とコンテンツを分離。

### Step 3: Claim抽出

`check_targets` に基づき、以下のパターンを抽出:

| Category | パターン例 | 検証手段 |
|----------|-----------|----------|
| statistics | 数値 + %、「〜万」「〜億」等の統計表現 | WebSearch (公式ソース照合) |
| pricing | 「月額〜円」「$〜/month」等の料金表現 | WebSearch (公式pricing page照合) |
| versions | 「v1.2.3」「バージョン〜」等のバージョン表現 | WebSearch (公式 release notes) |
| dates | 「2026年〜」「〜にリリース」等の日付表現 | WebSearch (公式アナウンス照合) |
| **urls** | 記事内に貼られた `https?://...` 全て | **WebFetch tool** で各 URL を fetch し、200 以外 (404/410/500/タイムアウト) を error 化。Bash の `curl`/`wget` は global `~/.claude/settings.json` の `permissions.deny` でブロックされているため使用不可 |
| **entities** | 「ある美容室では」「サロンA社では」等、実在しそうに見える事業者描写 | regex で signal を検出し writer に verify を要求（実在 verify できないなら削除/書き換え提案） |
| **testimonials** | testimonial 引用ブロック (`> 「...」` + 「担当者は/お客様は/責任者は/社員は/店長は/経営者は/マネージャーは」 + 「と振り返ります/と語ります/と話します/とおっしゃいます」等の組み合わせ) | regex で signal を検出し、引用元の実在性を要 verify |
| **self_claims** | 「弊社では〜を運用しています」「playpark では〜を活用」「私たちは〜を導入」等の自社オペレーション主張 | 実在 verify されていない主張は削除（または「〜という運用方法もある」のような一般論への書き換え）を提案。利用先プロジェクトに `references/publication-constraints.md` 等の必読 reference があればそれに従う |

### Step 4: 検証

検証手段は claim カテゴリごとに分岐:

**Web検索照合 (statistics/pricing/versions/dates):**
- 各 claim に対して WebSearch で公式ソースを検索し照合
- 公式ドキュメント・プレスリリースを優先
- 一致/不一致/確認不可をそれぞれ分類

**URL liveness (urls):**
- 記事から URL を抽出 (`grep -oE 'https?://[^)"]+' <mdx>`)
- 各 URL を **WebFetch tool** で fetch (Claude Code 標準 tool。deny されない)
- 200 以外 (404/410/500/タイムアウト/redirect 先 4xx) は error
- ⚠️ Bash の `curl`/`wget` は使わない (`permissions.deny` で block される)。subagent から curl を呼ぶと permission deny になり、最悪「200 だった」と虚偽報告するリスク = fabrication 対策 skill が fabrication を誘発する

**実在検証 (entities/testimonials/self_claims):**
- regex signal でヒットした箇所を列挙
- writer/ユーザーに「verify済みか」を確認
- verify不能なら以下のいずれかを推奨:
  - 削除
  - 観察的記述への書き換え（「ある〇〇社では」→「〇〇業の方なら」）
  - 一般論への書き換え（「弊社では運用しています」→「〜という運用方法もあります」）

`severity_threshold` に基づきフィルタリング。urls / fabrication 系は default で `error` 扱い。

### Step 5: レポート出力

**通常モード**: 検証結果をレポート出力（`output_dir` に保存）

**--fix モード**: `skill-config.json` の `auto_fix_categories` / `review_only_categories` を読んで挙動を分岐する。

- `auto_fix_categories` に属するカテゴリ → 公式ソースで verify 済みの正しい値で自動置換
- `review_only_categories` に属するカテゴリ → **auto-fix しない**。flag して human review に回す
  - フィクションを別のフィクションに書き換えるリスクを避けるための設計判断
  - urls の 404/410 は削除候補としてレポートするのみ。auto-fix はしない

**Default 設定（利用先プロジェクトでオーバーライド可）:**

| Config key | Default value |
|-----------|--------------|
| `auto_fix_categories` | `["statistics", "pricing", "versions", "dates"]` |
| `review_only_categories` | `["urls", "entities", "testimonials", "self_claims"]` |

`--fix` 完了時のサマリーには `auto_fixed` / `flagged_for_review` の件数をカテゴリ別に分けて報告する。

### レポート形式

```markdown
# Fact Check Report: {article-slug}
Date: {date}

## Summary
- Checked: {n} claims
- Passed: {n} | Warning: {n} | Error: {n}

## Findings

### ❌ ERROR: {claim description}
- **記事内**: "月額980円から"
- **公式情報**: "月額1,180円から（2026年2月改定）"
- **出典**: https://example.com/pricing
- **推奨修正**: "月額1,180円から"

### ⚠️ WARNING: {claim description}
...
```

## Preconditions

なし（独立動作）

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-fact-check success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-fact-check failure \
  --error-category <category> --error-msg "<message>"
```
