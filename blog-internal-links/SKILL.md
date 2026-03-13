---
name: blog-internal-links
description: |
  クラスタ内記事間の内部リンクを分析・挿入し、未公開記事へのリンクを防止するスキル。
  Use when: 内部リンク分析、クラスタリンク構築、リンク不足検出、未公開記事リンクチェックが必要な時。
  Accepts args: [--cluster "name"] [--check] [--fix] [--check-future]
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

## Workflow

```
1. Config読込 → 2. クラスタ構成取得 → 3. リンク解析 → 4. 問題検出 → 5. 修正/レポート
```

### Step 1: Config読込

skill-config.json から設定を取得。

### Step 2: クラスタ構成取得

`seo-strategy.json` の `cluster_keywords` からクラスタ構成を取得。
各クラスタに所属する記事を特定。

### Step 3: リンク解析

各 MDX 記事を Read し、内部リンクを抽出:
- Markdown リンク: `[text](/blog/slug)`
- MDX コンポーネント: `<Link href="/blog/slug">`
- インラインリンク: `<a href="/blog/slug">`

クラスタ内の記事間リンクマトリクスを構築。

### Step 4: 問題検出

#### リンク不足検出
- クラスタ内リンク数 < `min_links_per_article` の記事を検出
- ハブページ（`hub_dir`）へのリンクがない記事を検出

#### 未公開記事リンク検出

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
