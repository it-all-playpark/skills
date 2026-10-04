---
name: sns-announce
description: |
  Generate SNS announcement posts from MDX/Markdown articles or published URLs.
  Use when: (1) user wants to create social media posts from blog content,
  (2) needs X, LinkedIn, Google Business, Facebook, Bluesky, Threads text,
  (3) keywords like "SNS告知", "告知文", "投稿文", "announce", "social media post",
  (4) input: MDX/Markdown files or published blog URLs.
  Accepts args: <source> [--output FILE] [--format md|json|yaml] [--schedule "YYYY-MM-DD HH:MM"] [--dedupe] [--platforms LIST]
context: fork
model: sonnet
---

# SNS Announce

Generate platform-optimized social media posts from articles or URLs.

## Usage

```
/sns-announce <source> [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--output, -o FILE` | Output to file | config or stdout |
| `--format FORMAT` | md, json, yaml | config or md |
| `--schedule DATETIME` | Schedule time (enables Zernio API format) | config or none |
| `--dedupe` | Pre-check Zernio API and skip already scheduled platforms | false |
| `--platforms LIST` | Generate only the listed platforms (comma-separated) | all enabled |

**Priority**: CLI args > config file > defaults

## Configuration

Project config: `skill-config.json` (`sns-announce` section) -- defines base_url, output path/format, schedule mode, and per-platform enable/disable.

Details: [Config Schema](references/config-schema.md)

## UTM Parameter Auto-Append

When `utm.enabled: true` in config, all `{url}` placeholders MUST include UTM parameters.

### URL Construction Rule

For each platform, build the URL as:
```
{base_url}{url_pattern}?utm_source={source}&utm_medium={medium}&utm_campaign={slug}
```

Where:
- `{source}` = `utm.source_map[platform]` from config (e.g., `x`, `linkedin`, `google_business`)
- `{medium}` = `utm.medium` from config (default: `social`)
- `{slug}` = article slug (extracted from filename or URL path)

### Examples
```
# X
https://www.playpark.co.jp/blog/my-article?utm_source=x&utm_medium=social&utm_campaign=my-article

# LinkedIn
https://www.playpark.co.jp/blog/my-article?utm_source=linkedin&utm_medium=social&utm_campaign=my-article

# Google Business
https://www.playpark.co.jp/blog/my-article?utm_source=google_business&utm_medium=social&utm_campaign=my-article
```

### Important
- UTM parameters are appended to ALL URLs in generated posts (template `{url}` placeholders)
- Each platform gets its own `utm_source` value from `utm.source_map`
- If `utm.enabled` is false or missing, generate URLs without UTM parameters (backward compatible)

## Workflow

### Standard (without --dedupe)
```
1. Load config → 2. Extract metadata → 3. Build platform-specific UTM URLs → 4. Generate posts (all platforms) → 5. Write output
```

### Optimized (with --dedupe)
```
1. Load config → 2. Extract metadata (get date) → 3. Query Zernio API → 4. Build platform-specific UTM URLs → 5. Generate posts (needed only) → 6. Write output
```

**Key optimization**: When `--dedupe` is specified, query Zernio API BEFORE generation to identify which platforms need posts. This avoids wasting AI tokens generating content for already-scheduled platforms.

Details: [Dedupe Flow & Scripts](references/dedupe-flow.md)

## Platform Guidelines

See [Platform Guide](references/platform-guide.md) for detailed limits, audience, style, and templates per platform.

**Quick reference**: X 280（重み付き・下記）, LinkedIn 1,300, Google 1,500, Facebook 500推奨, Bluesky 300, Threads 500

### Length Gate (MUST)

X の上限 280 は**文字数ではなく重み付きカウント**: 東アジア幅 W/F の文字（漢字・かな・全角記号・絵文字の大半）=2、
それ以外=1、URL は長さに関係なく一律 23。日本語本文なら実質 ~120字 + URL + ハッシュタグで 280 に届く。
`wc -m` や `jq length` の値（codepoint 数）は当てにならない（JA 文は codepoint 数より大きくなる）。
Bluesky は素の文字数で 300。

生成した X / Bluesky 文は**出力を書く前に必ず**スクリプトで検証し、`over` が出たら本文（フック文）を削って再計測する。
URL とハッシュタグは削らない:

```bash
# Zernio array / standard JSON をまとめて
sns-announce-check-length post/blog/<date>-<slug>.json
# 単文
sns-announce-check-length --platform x "<text>"
```

出力は `<platform>\t<len>\t<limit>\t<ok|over>`、超過があれば exit 1。280 ちょうどは ok だが、目安は **270 以下**に収める
（Zernio 側の差し替えや絵文字の幅判定ぶれの余地を残す）。

## Output Format

Markdown (default): separator-delimited blocks per platform. JSON: standard object or Zernio API array format when schedule is enabled.

Details: [Output Formats](references/output-formats.md)

## Examples

```bash
# Auto-save to config path
/sns-announce content/blog/2026-01-15-article.mdx

# With dedupe (optimized: only generates needed platforms)
/sns-announce content/blog/2026-01-15-article.mdx --dedupe

# Override output
/sns-announce article.mdx --output custom/path.md

# URL input
/sns-announce https://example.com/blog/my-article

# Specific platforms
/sns-announce article.mdx --platforms x,linkedin

# Zernio API format with schedule
/sns-announce article.mdx --format json --schedule "2026-03-12 09:00"
```
