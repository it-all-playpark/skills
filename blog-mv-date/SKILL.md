---
name: blog-mv-date
description: |
  Move a blog article to a new publish date, updating MDX, images, seed files, and SNS post schedules.
  Use when: (1) user wants to move/change a single article's publish date,
  (2) keywords like "日付変更", "投稿日移動", "move date", "記事の日付を変える", "公開日変更",
  (3) user wants to reschedule a blog article to a different date.
  Accepts args: <article> <dest-date> [--dry-run]
user-invocable: true
---

# Blog Move Date

ブログ記事の投稿日を指定日に移動する。

## Usage

```
/blog-mv-date <article> <dest-date> [--dry-run]
```

| Arg        | Description                             |
| ---------- | --------------------------------------- |
| article    | 記事の識別子（ファイルパス、日付、slug、部分マッチ） |
| dest-date  | 移動先の日付 (`YYYY-MM-DD`)             |
| --dry-run  | 変更内容を表示するのみ                  |

## Workflow

### Step 1: 記事の特定

```bash
bash $SKILLS_DIR/_shared/scripts/find-articles.sh <identifier>
```

複数マッチ時はユーザーに選択を求める。

### Step 2: 移動先日付のバリデーション

- `YYYY-MM-DD` 形式であること
- 移動先に同一slugの記事が存在しないこと

### Step 3: Dry-run確認（推奨）

```bash
bash $SKILLS_DIR/blog-mv-date/scripts/move-date.sh <path> <dest-date> --dry-run
```

### Step 4: 実行

```bash
bash $SKILLS_DIR/blog-mv-date/scripts/move-date.sh <path> <dest-date>
```

### Step 5: ビルド検証

```bash
npm run build
```

### Step 6: Zernio API（旧Late）手順表示

Zernio API（旧Late）に既存スケジュールがある場合、手動変更手順を提示：

```markdown
## Zernio API（旧Late） 手動変更手順

### [記事のタイトル]

- 検索: [slug keyword]
- 変更: YYYY-MM-DD → YYYY-MM-DD
```

## Config

`skill-config.json` の `blog-mv-date` セクション:

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

| Error                    | Action                   |
| ------------------------ | ------------------------ |
| 記事が見つからない       | 利用可能な記事一覧を表示 |
| 複数マッチ               | AskUserQuestionで選択    |
| 移動先に記事が既存       | エラー終了               |
| 日付形式が不正           | エラー終了               |
| 画像なし                 | 警告して続行             |
| seedなし                 | 警告して続行             |
| ビルド失敗               | ロールバック手順を提示   |

## Examples

```bash
# ファイルパスで指定
/blog-mv-date content/blog/2026-02-03-foo.mdx 2026-03-19

# slugで指定
/blog-mv-date claude-code-skills 2026-04-01

# 日付で指定
/blog-mv-date 2026-02-03 2026-03-19

# dry-run
/blog-mv-date claude-code-skills 2026-04-01 --dry-run
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-mv-date success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-mv-date failure \
  --error-category <category> --error-msg "<message>"
```
