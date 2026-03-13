---
name: blog-swap-dates
description: |
  Swap publish dates between two blog articles including MDX, images, seed files, and SNS post schedules.
  Use when: (1) user wants to swap/exchange dates between articles,
  (2) keywords like "投稿日入れ替え", "日付交換", "swap dates", "記事の日付を入れ替え",
  (3) user wants to reorder blog publish schedule.
  Accepts args: <article1> <article2> [--dry-run]
user-invocable: true
---

# Blog Swap Dates

2つのブログ記事の投稿日を入れ替える。

## Usage

```
/blog-swap-dates <article1> <article2> [--dry-run]
```

| Arg       | Description                             |
| --------- | --------------------------------------- |
| article1  | 記事1の識別子（日付、slug、部分マッチ） |
| article2  | 記事2の識別子                           |
| --dry-run | 変更内容を表示するのみ                  |

## Workflow

### Step 1: 記事の特定

```bash
bash $SKILLS_DIR/_shared/scripts/find-articles.sh <identifier>
```

複数マッチ時はユーザーに選択を求める。

### Step 2: Dry-run確認（推奨）

```bash
bash $SKILLS_DIR/blog-swap-dates/scripts/swap-dates.sh <path1> <path2> --dry-run
```

### Step 3: 実行

```bash
bash $SKILLS_DIR/blog-swap-dates/scripts/swap-dates.sh <path1> <path2>
```

### Step 4: ビルド検証

```bash
npm run build
```

### Step 5: Late API手順表示

Late APIに既存スケジュールがある場合、手動変更手順を提示：

```markdown
## Late API 手動変更手順

### 1. [Article1のタイトル]

- 検索: [slug keyword]
- 変更: YYYY-MM-DD → YYYY-MM-DD

### 2. [Article2のタイトル]

- 検索: [slug keyword]
- 変更: YYYY-MM-DD → YYYY-MM-DD
```

## Config

`skill-config.json` の `blog-swap-dates` セクション:

```json
{
  "content_dir": "content/blog",
  "image_dir": "public/blog",
  "image_ext": ".webp",
  "seed_dir": "seed",
  "sns_post_dir": "post/blog"
}
```

## Shared Resources

- `~/.claude/skills/_shared/scripts/find-articles.sh` - 記事検索スクリプト
- `~/.claude/skills/_shared/references/file-patterns.md` - ファイルパス規則

## Error Handling

| Error              | Action                   |
| ------------------ | ------------------------ |
| 記事が見つからない | 利用可能な記事一覧を表示 |
| 複数マッチ         | AskUserQuestionで選択    |
| 画像なし           | 警告して続行             |
| seedなし           | 警告して続行             |
| ビルド失敗         | ロールバック手順を提示   |

## Examples

```bash
# 日付で指定
/blog-swap-dates 2026-02-03 2026-03-19

# slugで指定
/blog-swap-dates nissan-united-log claude-code-skills

# dry-run
/blog-swap-dates 2026-02-03 2026-03-19 --dry-run
```
