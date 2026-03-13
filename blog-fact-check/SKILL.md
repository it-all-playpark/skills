---
name: blog-fact-check
description: |
  MDX記事内の統計データ・バージョン情報・料金等を抽出し、公式ソースと照合するファクトチェックスキル。
  Use when: 記事の事実確認、データ検証、料金チェック、バージョン確認が必要な時。
  Accepts args: [file-path] [--all] [--category statistics|pricing|versions|dates] [--fix]
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
| check_targets | ["statistics", "pricing", "versions", "dates"] | チェック対象カテゴリ |
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

| Category | パターン例 |
|----------|-----------|
| statistics | 数値 + %、「〜万」「〜億」等の統計表現 |
| pricing | 「月額〜円」「$〜/month」等の料金表現 |
| versions | 「v1.2.3」「バージョン〜」等のバージョン表現 |
| dates | 「2026年〜」「〜にリリース」等の日付表現 |

### Step 4: Web検索照合

各 claim に対して WebSearch で公式ソースを検索し照合:
- 公式ドキュメント・プレスリリースを優先
- 一致/不一致/確認不可をそれぞれ分類
- `severity_threshold` に基づきフィルタリング

### Step 5: レポート出力

**通常モード**: 検証結果をレポート出力（`output_dir` に保存）
**--fix モード**: 不一致箇所を修正し、変更差分を表示

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
