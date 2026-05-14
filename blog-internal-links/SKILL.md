---
name: blog-internal-links
description: |
  クラスタ内記事間の内部リンクを分析・挿入し、未公開記事へのリンクを防止するスキル。
  Use when: 内部リンク分析、クラスタリンク構築、リンク不足検出、未公開記事リンクチェックが必要な時。
  Accepts args: [--cluster "name"] [--check] [--fix] [--check-future]
context: fork
model: sonnet
---

# Blog Internal Links

クラスタ内記事間の内部リンクを分析・挿入する。

## Usage

```
/blog-internal-links
/blog-internal-links --cluster "Claude Code"
/blog-internal-links --check
/blog-internal-links --fix
/blog-internal-links --check-future
```

| Arg | Description |
|-----|-------------|
| --cluster | 対象クラスタ名（省略時は全クラスタ） |
| --check | 分析のみ（変更なし） |
| --fix | 不足リンクを自動挿入 |
| --check-future | 未公開記事へのリンクのみチェック |

## Config

skill-config.json の `blog-internal-links` セクションから設定を読み込む。

| Key | Default | Description |
|-----|---------|-------------|
| content_dir | content/blog | MDX記事ディレクトリ |
| blog_path_prefix | /blog/ | ブログURLプレフィックス |
| cluster_source | seo-strategy | クラスタ定義の参照先 |
| hub_dir | "" | ハブページディレクトリ |
| min_links_per_article | 2 | 記事あたり最小内部リンク数 |
| max_links_per_article | 5 | 記事あたり最大内部リンク数 |
| prevent_future_links | true | 未公開記事へのリンク防止 |
| output_dir | claudedocs | レポート出力先 |

## Scripts

以下の deterministic スクリプトでリンクデータ収集を行い、LLM はクラスタ分析・リンク挿入・判断に専念する。

### `scripts/extract-links.sh`

全 MDX 記事から内部リンクを抽出しリンクマトリクスを構築。

```bash
scripts/extract-links.sh [--content-dir DIR] [--blog-prefix PREFIX]
# Output: JSON
# {"links": {"slug-a": ["slug-b", "slug-c"]}, "counts": {"slug-a": 2}}
```

- Markdown リンク: `[text](/blog/slug)`
- JSX/MDX href: `<Link href="/blog/slug">`, `<a href="/blog/slug">`
- slug ごとにリンク先を deduplicate

### `scripts/check-future-links.sh`

未公開記事へのリンク違反を検出。

```bash
scripts/check-future-links.sh --links-json <path> [--content-dir DIR]
# Output: JSON array
# [{"from": "slug-a", "to": "slug-b", "reason": "future_date|draft|seed_only|not_found", "target_date": "..."}]
```

- extract-links.sh の出力 JSON を入力として使用
- 各リンク先の公開状態を frontmatter から判定

## Workflow

```
1. Script: extract-links.sh → 2. Script: check-future-links.sh → 3. LLM: クラスタ構成取得 → 4. LLM: 問題検出・修正/レポート
```

### Step 1-2: データ収集（Script）

`extract-links.sh` でリンクマトリクスを構築し、`check-future-links.sh` で未公開リンク違反を検出。

### Step 3: クラスタ構成取得（LLM）

`seo-strategy.json` の `cluster_keywords` からクラスタ構成を取得。
各クラスタに所属する記事を特定し、スクリプト出力のリンクデータとクラスタを突合。

### Step 4: 問題検出・修正/レポート（LLM）

#### リンク不足検出
- クラスタ内リンク数 < `min_links_per_article` の記事を検出
- ハブページ（`hub_dir`）へのリンクがない記事を検出

#### 未公開記事リンク検出（check-future-links.sh の結果を使用）

以下のいずれかに該当する記事へのリンクを「未公開リンク」として検出:

1. **未来日付**: MDX frontmatter の `date` が today より後
2. **ドラフト**: frontmatter に `draft: true` が設定
3. **Seed のみ**: `seed/` にのみ存在し、`content/blog/` に MDX が未生成

### Step 5: 修正/レポート

#### --check モード（デフォルト）

```markdown
# Internal Links Report
Date: {date}

## Cluster: Claude Code
Articles: 5 | Links: 12 | Avg: 2.4/article

### Link Matrix
| From → To | guide | hooks | settings | tips | comparison |
|-----------|-------|-------|----------|------|------------|
| guide     | -     | ✅    | ✅       | ❌   | ❌         |
| hooks     | ✅    | -     | ❌       | ❌   | ❌         |
| ...       |       |       |          |      |            |

### Issues
- claude-code-tips: 0 cluster links (min: 2)
- claude-code-comparison: 1 cluster link (min: 2)
- claude-code-hooks → claude-code-vs-codex: links to unpublished article (date: 2026-03-17)
```

#### --fix モード

不足リンクを記事の適切な位置に挿入:
- 関連する段落の近くにコンテキストに合ったアンカーテキストで挿入
- `max_links_per_article` を超えない
- 未公開記事へのリンクは挿入しない

#### --check-future モード

未公開記事へのリンクのみを検出・報告。`--fix` と組み合わせると該当リンクを削除。

## Preconditions

- `claudedocs/seo-strategy.json` が存在すること（クラスタ定義の参照に必要）

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-internal-links success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-internal-links failure \
  --error-category <category> --error-msg "<message>"
```
