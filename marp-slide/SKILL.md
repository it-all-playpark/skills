---
name: marp-slide
description: |
  Generate professional Marp presentation slides from documents or text input.
  Use when: (1) creating slides/presentations from MD/MDX files,
  (2) keywords like "スライド", "プレゼン", "Marp", "発表資料", "LT", "営業資料",
  (3) user has content and wants presentation output.
  Accepts args: <source> [--type X] [--tone Y] [--theme Z] [--format md|pdf|html|pptx] [-o path]
user-invocable: true
---

# Marp Slide Generator

営業資料品質のプレゼンテーションスライドを生成。

## Usage

```
/marp-slide <source> [options]
```

| Arg | Description |
|-----|-------------|
| source | MD/MDX file path, or direct text (quoted) |
| --type | problem-solution, product-intro, tech-talk, tutorial, lightning-talk |
| --tone | formal, casual, educational |
| --theme | minimal, corporate, colorful |
| --format | md, pdf, html, pptx (default: md) |
| --notes | Generate speaker notes (default: true) |
| --skip-selection | Skip interactive selection, use defaults |
| -o | Output path (default: ./slides.md) |

## Selection Flow

### Step 1: Type Selection (必須)

| Type | Use Case | Slide Count |
|------|----------|-------------|
| problem-solution | 導入事例・課題解決 | 10-15 |
| product-intro | プロダクト紹介 | 8-12 |
| tech-talk | 技術発表 | 10-15 |
| tutorial | チュートリアル | 12-20 |
| lightning-talk | LT | 5-8 |

### Step 2: Tone/Theme (自動推奨)

| Type | Tone | Theme |
|------|------|-------|
| problem-solution | formal | corporate |
| product-intro | formal | corporate |
| tech-talk | casual | minimal |
| tutorial | educational | colorful |
| lightning-talk | casual | colorful |

### Skip Selection

```bash
/marp-slide ./file.md --skip-selection              # デフォルト値で即生成
/marp-slide ./file.md --type problem-solution --tone formal --theme corporate  # 全指定
```

## Workflow

```
[1] Parse input → File path or quoted text

[2] Content Analysis → Detect type (see design-guidelines.md for rules)

[3] Interactive Selection (unless --skip-selection or all options specified)
    - Type選択 → Tone/Theme自動推奨

[4] Load references (conditional)
    - Always: design-guidelines.md
    - Based on --type: structures/{type}.md
    - Based on --theme: themes/{theme}.css
    - As needed: snippets/*.html

[5] Generate slides
    - Apply structure pattern from structures/{type}.md
    - Use layout classes (cover, lead, agenda, two-col, comparison, kpi-cards, testimonial, flow, closing)
    - **Tables must be HTML** (see snippets/table.html)
    - Add speaker notes with timing

[6] Logo Injection (if theme uses logo)
    - Run: scripts/inject-logo.sh <output.md>

[7] Export (if format != md)
    - Run: scripts/export.sh <output.md> --format <format>
```

## Reference Loading Strategy

```
references/
├── design-guidelines.md   # Always load (デザインルール・検出ルール)
├── tones.md               # Load when tone customization needed
├── structures/            # Load ONE based on --type
├── themes/                # Load ONE based on --theme
└── snippets/              # Load as needed during generation
```

## Table Guidelines (IMPORTANT)

**テーブルはMarkdownではなくHTMLで記述。**

- Markdownテーブルは列幅制御不可
- `<colgroup>` + CSS classes (w-20〜w-80) で幅指定
- Reference: `snippets/table.html`

## Logo Customization

```bash
# 自社ロゴに差し替え
cp /path/to/my-logo.png assets/logo.png

# カスタムロゴ指定
scripts/inject-logo.sh slides.md --logo assets/logo-white.png
```

## Examples

```bash
/marp-slide ./case-study.md                         # 対話的に選択
/marp-slide ./case-study.md --type problem-solution # タイプ指定
/marp-slide ./slides.md --format pdf -o ./out.pdf   # PDF出力
```

## References

- `references/design-guidelines.md` - デザインルール、レイアウトクラス、検出ルール
- `references/structures/{type}.md` - スライド構造パターン
- `references/themes/{theme}.css` - CSSテーマ
- `references/snippets/*.html` - HTMLコンポーネント
- `scripts/inject-logo.sh` - ロゴ注入
- `scripts/export.sh` - PDF/HTML/PPTX変換