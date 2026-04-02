---
name: cross-post-publish
description: |
  Orchestrate blog cross-posting to Zenn and Qiita in one workflow.
  Use when: (1) user wants to cross-post article to external platforms,
  (2) keywords like "クロスポスト投稿", "Zenn/Qiita投稿", "外部公開準備",
  (3) user wants end-to-end cross-post workflow from article selection.
  Accepts args: [slug] [--skip-qiita] [--skip-zenn]
user-invocable: true
---

# Cross-Post Publish

content/blog/記事をZenn/Qiitaにクロスポスト投稿するオーケストレーター。

## References

- `~/.claude/skills/_shared/references/cross-post-categories.md` - 対象カテゴリ定義

## Usage

```
/cross-post-publish [slug] [--skip-qiita] [--skip-zenn]
```

## CRITICAL: Non-Stop Execution

**このskillはPhase 1〜3を連続実行する。途中で止まらない。**

```
Init → [Select] → Convert → Publish(並列) → Complete
```

ユーザー入力が必要なのはPhase 1の記事選択のみ。選択後はPhase 3完了まで一気に実行。

## Init

```bash
bash ~/.claude/skills/cross-post-publish/scripts/list-articles.sh --recent 10
```

**出力に含まれる情報:**

- `articles`: 対象カテゴリの記事一覧
- `skipped`: 対象外カテゴリの記事一覧（参考情報）
- `valid_categories`: 対象カテゴリ一覧

## Filters

| Filter   | 説明                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| カテゴリ | configのcross_post_categoriesのみ（`_shared/references/cross-post-categories.md`参照） |
| 日付     | 今日以前の記事のみ                                                               |
| 既存     | `cross_post_dir/<slug>/`が存在する記事は除外                                    |

## Workflow

### Phase 1: Article Selection (slug未指定時のみ)

1. list-articles.shで記事一覧取得
2. 対象外カテゴリの記事があればスキップ理由を表示
3. AskUserQuestionで選択（タイトル + 日付 + カテゴリ）
4. **選択後、即座にPhase 2へ進む**

### Phase 2: Convert → 完了後すぐPhase 3へ

`/blog-cross-post <slug> --platform both --output post/cross-post/<slug>/`

出力: `post/cross-post/<slug>/qiita.md`, `post/cross-post/<slug>/zenn.md`

**⚠️ Phase 2完了後、止まらずにPhase 3を実行する**

### Phase 3: Publish (並列実行)

Phase 2の出力ファイルを使って、以下を**単一メッセージで同時に**呼び出す:

| Skill            | Args                              |
| ---------------- | --------------------------------- |
| `/qiita-publish` | `post/cross-post/<slug>/qiita.md` |
| `/zenn-publish`  | `post/cross-post/<slug>/zenn.md`  |

`--skip-qiita`/`--skip-zenn`指定時は該当skillをスキップ。

## Config

`skill-config.json` の `cross-post-publish` セクション:

```json
{
  "content_dir": "content/blog",
  "cross_post_dir": "post/cross-post",
  "cross_post_categories": ["tech-tips", "lab-reports"]
}
```

## Output

```
Cross-Post Complete

Source: content/blog/YYYY-MM-DD-<slug>.mdx
Category: tech-tips
Zenn: クリップボード + ブラウザ
Qiita: 限定共有で投稿済み
URL: https://www.playpark.co.jp/blog/<slug>
```

## Error Cases

| エラー                         | 対応                                     |
| ------------------------------ | ---------------------------------------- |
| 対象カテゴリの記事がない       | スキップされた記事一覧を表示、終了       |
| slug指定の記事が対象外カテゴリ | エラーメッセージ表示、対象カテゴリを案内 |

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log cross-post-publish success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log cross-post-publish failure \
  --error-category <category> --error-msg "<message>"
```
