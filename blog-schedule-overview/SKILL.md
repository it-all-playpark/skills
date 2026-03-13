---
name: blog-schedule-overview
description: |
  全記事の公開スケジュールをカレンダー表示し、空きスロット・重複・整合性を検出するスキル。
  Use when: 記事スケジュール確認、空きスロット検出、公開日程管理、カレンダー表示が必要な時。
  Accepts args: [--days N] [--check] [--format table|calendar] [--save]
---

# Blog Schedule Overview

全記事の公開スケジュールを一覧表示・管理する。

## Usage

```
/blog-schedule-overview
/blog-schedule-overview --days 60
/blog-schedule-overview --check
/blog-schedule-overview --format calendar
/blog-schedule-overview --save
```

| Arg | Description |
|-----|-------------|
| --days | 表示する未来日数（デフォルト: 30） |
| --check | 空きスロット・重複検出モード |
| --format | 出力形式: table または calendar |
| --save | output_dir にレポート保存 |

## Config

skill-config.json の `blog-schedule-overview` セクションから設定を読み込む。

| Key | Default | Description |
|-----|---------|-------------|
| content_dir | content/blog | MDX記事ディレクトリ |
| seed_dir | seed | 作成中記事ディレクトリ |
| sns_post_dir | post/blog | SNS投稿スケジュールディレクトリ |
| publish_days | ["monday", "thursday"] | 公開曜日 |
| lookahead_days | 30 | 表示する未来日数 |
| lookback_days | 7 | 表示する過去日数 |
| content_strategy_path | "" | content-strategy.json パス |
| seo_strategy_path | "" | seo-strategy.json パス |
| output_dir | "" | レポート保存先（空=表示のみ） |

## Workflow

```
1. Config読込 → 2. MDX日付抽出 → 3. Seed検出 → 4. SNS照合 → 5. 戦略整合性チェック → 6. 表示/保存
```

### Step 1: Config読込

skill-config.json から設定を取得。`--days` 引数で `lookahead_days` をオーバーライド可能。

### Step 2: MDX日付抽出

`content_dir` の全 MDX ファイルを Glob で列挙し、各ファイルの frontmatter `date` を Read で抽出。

**重要**: bash スクリプトによる YAML パースは行わない。Claude が直接 Read して frontmatter を解析する。
（理由: `date:` の本文中出現で誤検出、マルチラインフロントマターの扱い等を回避）

各記事の状態を判定:
- **公開済み**: `date` が today 以前、かつ `draft: true` でない
- **予定**: `date` が today より後
- **ドラフト**: `draft: true` が設定されている

### Step 3: Seed検出

`seed_dir` を確認し、まだ `content_dir` に MDX が生成されていない記事を「作成中」として列挙。

### Step 4: SNS照合

`sns_post_dir` の JSON ファイルを確認し、各記事の SNS 投稿スケジュール状況を照合。

### Step 5: 戦略整合性チェック

`content_strategy_path` / `seo_strategy_path` が存在する場合:
- 未スケジュールの記事がないか確認
- クラスタカバレッジの確認

### Step 6: 表示/保存

#### Calendar形式（デフォルト）
```
Blog Schedule: 2026-03-13 - 2026-04-13

Week 11 (Mar 9-15)
  Mon 03/10  ✅ claude-code-hooks-safety-design
  Thu 03/13  ✅ ai-coding-tools-comparison

Week 12 (Mar 16-22)
  Mon 03/17  📝 claude-code-vs-codex (draft)
  Thu 03/20  ⬜ [empty slot]

Week 13 (Mar 23-29)
  Mon 03/24  🌱 openclaw-gemini (seed only)
  Thu 03/27  ⬜ [empty slot]
```

#### Table形式
```
| Date       | Day | Status | Slug                          | SNS |
|------------|-----|--------|-------------------------------|-----|
| 2026-03-10 | Mon | ✅     | claude-code-hooks-safety-design | ✅  |
| 2026-03-13 | Thu | ✅     | ai-coding-tools-comparison     | 📅  |
| 2026-03-17 | Mon | 📝     | claude-code-vs-codex (draft)   | -   |
| 2026-03-20 | Thu | ⬜     | [empty slot]                   | -   |
```

#### Issues セクション（--check 時）
```
Issues:
  - 03/20 (Thu): empty slot (seed candidates: 3)
  - 03/27 (Thu): empty slot
  - content-strategy.json: 2 articles unscheduled
  - 03/10, 03/13: 2 articles missing SNS schedule
```

#### 保存
`--save` 指定時、`output_dir` に `blog-schedule-YYYY-MM-DD.md` として保存。
`output_dir` が空の場合は表示のみ。

## Preconditions

なし（独立動作）
