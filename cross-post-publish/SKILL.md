---
name: cross-post-publish
description: |
  Orchestrate blog cross-posting to Zenn and Qiita in one workflow.
  Use when: (1) user wants to cross-post article to external platforms,
  (2) keywords like "クロスポスト投稿", "Zenn/Qiita投稿", "外部公開準備",
  (3) user wants end-to-end cross-post workflow from article selection.
  Accepts args: [slug] [--skip-qiita] [--skip-zenn]
user-invocable: true
context: fork
model: sonnet
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

**このskillはPhase 1〜3を連続実行する。Phase 1.5 の確認後は途中で止まらない。**

```
Init → [Select] → [Confirm Target] → Convert → Publish(並列) → Complete
```

ユーザー入力が必要なのは Phase 1 の記事選択 と Phase 1.5 の対象確認のみ。Phase 1.5 で確定した後は Phase 3 完了まで一気に実行。

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
4. **選択後、即座に Phase 1.5 へ進む**

### Phase 1.5: Confirm Target（必須・スキップ不可）

> 過去に「記事 #9 を選んだのに #10 が公開された」事故の再発防止のための hard gate。
> slug が引数で明示されたケースでも **必ず** 実行する（typo / 同名 slug / LLM のスコープ誤読を捕捉）。

1. Phase 1 で選択された / 引数で指定された slug を `content_dir/YYYY-MM-DD-<slug>.mdx` に解決
   - 該当ファイルが見つからない / 複数ヒットする場合は **halt** してユーザーに修正を要求
2. 解決した MDX を Read し以下を抽出:
   - `title`（frontmatter）
   - `date`（frontmatter または filename）
   - `category`（frontmatter）
   - 本文先頭 200 文字（excerpt）
3. AskUserQuestion で確認:

   ```
   以下の記事を Zenn / Qiita に公開します。よろしいですか？

   File:     content/blog/YYYY-MM-DD-<slug>.mdx
   Title:    <title>
   Date:     YYYY-MM-DD
   Category: <category>

   <excerpt 200 chars>...
   ```

   選択肢:
   - 「はい、公開する」 → Phase 2 へ
   - 「いいえ、キャンセル」 → 何もせず終了

4. キャンセル時は外部 API 呼び出しを一切行わずに終了する

**実装メモ:**
- `--skip-qiita` / `--skip-zenn` 指定時は確認画面に「Zenn のみ公開」「Qiita のみ公開」と公開先を明示
- 公開先 URL（例: `https://www.playpark.co.jp/blog/<slug>`）も併記する

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
| slug 解決で MDX が見つからない | Phase 1.5 で halt。slug を修正して再実行 |
| slug が複数 MDX にヒット       | Phase 1.5 で halt。候補を提示し再選択させる |
| Phase 1.5 でユーザーが「いいえ」 | 外部 API を呼ばず終了。冪等性を保つ      |

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
