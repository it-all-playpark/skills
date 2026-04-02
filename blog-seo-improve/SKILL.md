---
name: blog-seo-improve
description: |
  GSC/GAデータに基づき、既存記事のtitle/description/冒頭セクションを改善するSEOスキル。
  Use when: 既存記事のSEO改善、CTR改善、bounce率改善、title/meta最適化が必要な時。
  Accepts args: [file-path] [--type ctr|bounce] [--dry-run]
---

# Blog SEO Improve

GSC/GAデータに基づき、既存記事のSEOを改善する。

## Usage

```
/blog-seo-improve
/blog-seo-improve content/blog/2026-03-04-*.mdx
/blog-seo-improve --type ctr
/blog-seo-improve --type bounce
/blog-seo-improve --dry-run
```

| Arg | Description |
|-----|-------------|
| file-path | 改善対象のMDXファイルパス（省略時は自動検出） |
| --type | 改善タイプ: ctr（CTR改善）, bounce（bounce率改善） |
| --dry-run | 変更せず提案のみ |

## Config

skill-config.json の `blog-seo-improve` セクションから設定を読み込む。

| Key | Default | Description |
|-----|---------|-------------|
| content_dir | content/blog | MDX記事ディレクトリ |
| gsc_site | "" | GSCサイト識別子（必須） |
| ga_property_id | "" | GA4プロパティID（必須） |
| thresholds.low_ctr | 0.02 | CTR改善対象の閾値 |
| thresholds.high_bounce | 0.75 | bounce率改善対象の閾値 |
| thresholds.min_impressions | 50 | 分析対象の最小impression数 |
| output_dir | claudedocs | レポート出力先 |

## Workflow

```
1. Config読込 → 2. データ取得 → 3. 改善対象特定 → 4. 改善実行 → 5. レポート
```

### Step 1: Config読込

skill-config.json から設定を取得。`gsc_site` と `ga_property_id` が未設定の場合はエラー。

### Step 2: データ取得

以下のいずれかからデータを取得:
1. `gsc` skill / `ga-analyzer` skill を呼び出してリアルタイムデータを取得
2. `claudedocs/` 配下の既存レポートを参照（TTL: 30日以内）

**必要なデータフィールド**（`references/input-schema.md` 参照）:
- GSC: `query`, `page`, `clicks`, `impressions`, `ctr`, `position`
- GA4: `pagePath`, `sessions`, `bounceRate`, `engagementRate`, `avgSessionDuration`
- seo-strategy: `clusters[].articles[]`, `optimization_opportunities[]`

### Step 3: 改善対象特定

閾値に基づき改善対象記事を特定:

| Type | 条件 | 改善内容 |
|------|------|---------|
| ctr | CTR < `low_ctr` かつ impressions >= `min_impressions` | title, meta description 改善 |
| bounce | bounceRate > `high_bounce` | 冒頭セクション、見出し構成 改善 |

### Step 4: 改善実行

**CTR改善**:
- title: クリック誘引力の向上（キーワード前置、数字活用、疑問形）
- meta description: CTA強化、具体的ベネフィット明示
- `seo-strategy` のクラスタキーワードとの整合性維持

**Bounce率改善**:
- 冒頭セクション: 結論先出し、読者の課題に即座に応答
- 見出し構成: スキャナビリティ向上、H2/H3の最適化
- 内部リンク: 関連記事への導線追加

**--dry-run モード**: ファイル変更せず、提案をレポートのみ出力。

### Step 5: レポート

```markdown
# SEO Improvement Report
Date: {date}

## Summary
- Analyzed: {n} articles
- Improved: {n} articles (CTR: {n}, Bounce: {n})

## Changes

### {article-slug}
**Type**: CTR improvement
**Before**:
- Title: "Claude Codeの使い方"
- CTR: 1.2% (impressions: 340)

**After**:
- Title: "Claude Code完全ガイド：5分で始める実践的な使い方【2026年版】"
- Expected CTR improvement: +0.5-1.0%

**Diff**:
\`\`\`diff
- title: "Claude Codeの使い方"
+ title: "Claude Code完全ガイド：5分で始める実践的な使い方【2026年版】"
\`\`\`
```

## Preconditions

- `claudedocs/seo-strategy.json` が存在すること（なければ `/seo-strategy` を先に実行）
- データが30日以内であること
- `gsc_site` と `ga_property_id` が config に設定されていること

## Dependencies

| Skill | 関係 |
|-------|------|
| gsc | GSCデータ取得 |
| ga-analyzer | GAデータ取得 |
| seo-strategy | クラスタ・キーワード戦略参照 |

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-seo-improve success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-seo-improve failure \
  --error-category <category> --error-msg "<message>"
```
