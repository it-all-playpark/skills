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

# Marp Slide Generator - Enhanced Edition

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

スライド生成前に対話的な選択フローを実行。ユーザーがタイプ・トーン・テーマを選択できる。

### Step 1: Type Selection (必須)

コンテンツを分析し、推奨タイプをハイライト表示。

| Type | Use Case | Slide Count |
|------|----------|-------------|
| problem-solution | 導入事例・課題解決 | 10-15 |
| product-intro | プロダクト紹介 | 8-12 |
| tech-talk | 技術発表 | 10-15 |
| tutorial | チュートリアル | 12-20 |
| lightning-talk | LT | 5-8 |

### Step 2: Tone/Theme Selection

Type選択後、推奨Tone/Themeを自動設定。変更可能。

| Type | Recommended Tone | Recommended Theme |
|------|------------------|-------------------|
| problem-solution | formal | corporate |
| product-intro | formal | corporate |
| tech-talk | casual | minimal |
| tutorial | educational | colorful |
| lightning-talk | casual | colorful |

### Skip Selection

選択フローをスキップする方法：

```bash
# デフォルト値で即生成
/marp-slide ./file.md --skip-selection

# 全オプション指定で自動スキップ
/marp-slide ./file.md --type problem-solution --tone formal --theme corporate
```

## Type Detection Rules

コンテンツから自動的にタイプを推定：

| Content Pattern | Detected Type | Confidence |
|-----------------|---------------|------------|
| "課題", "導入前/後", "効果", "削減" | problem-solution | High |
| "機能", "特徴", "価格", "プラン" | product-intro | High |
| "実装", "コード", "技術", "アーキテクチャ" | tech-talk | High |
| "手順", "ステップ", "学習", "始め方" | tutorial | High |
| 短い内容（500字以下） | lightning-talk | Medium |

## Layout Classes

生成時に以下のレイアウトクラスを活用：

| Class | Use Case | Auto-Detection |
|-------|----------|----------------|
| `cover` | タイトルスライド | 最初のスライド |
| `lead` | セクション区切り | セクション見出し |
| `agenda` | 目次 | "目次", "アジェンダ" |
| `two-col` | 2カラム | 画像+テキスト |
| `comparison` | Before/After | "導入前/後", 比較表 |
| `kpi-cards` | 数値強調 | 数値 + "削減/改善" |
| `testimonial` | お客様の声 | 引用形式 |
| `flow` | フロー図 | ステップ形式 |
| `closing` | Thank you | 最後のスライド |

## Workflow

```
[1] Parse input
    - File path → Read content
    - Quoted text → Use directly

[2] Content Analysis
    - Detect keywords for type inference
    - Calculate confidence scores
    - Prepare recommendation

[3] Interactive Selection Flow
    Step 1: Type選択 (required)
    - Show detected type as recommendation
    - User selects from 5 options using AskUserQuestion

    Step 2: Tone/Theme選択 (with recommendations)
    - Based on Type, show recommended Tone/Theme
    - User can accept or change
    - Skip if all specified via args or --skip-selection

[4] Load references (conditional)
    - Always: references/README.md, references/design-guidelines.md
    - Based on --type: references/structures/{type}.md
    - Based on --theme: references/themes/{theme}.css
    - As needed: references/snippets/*.html, references/tones.md

[5] Determine structure
    - Apply selected type pattern from structures/{type}.md
    - Map content to appropriate slide types

[6] Generate slides with layouts
    - Apply cover class to first slide
    - Detect KPI patterns → Use kpi-cards HTML from snippets/
    - Detect Before/After → Use comparison layout from snippets/
    - Detect quotes → Use testimonial layout from snippets/
    - Detect step sequences → Use flow layout from snippets/
    - **Detect tables → Use HTML table from snippets/table.html (NOT Markdown)**
    - Apply closing class to last slide
    - Add speaker notes with timing

    **IMPORTANT: Tables must be HTML, not Markdown**
    - Markdown tables cannot control column widths
    - Use `<colgroup>` with CSS classes for column widths
    - **CRITICAL: Marp inherits github-markdown-css which sets `display:block; width:max-content` on tables!**
      - This causes tables to shrink to content width instead of 100%
      - Theme CSS MUST override with `display: table !important; width: 100% !important;`
      - All theme CSS files include these overrides
    - **CRITICAL: `table-layout: fixed` is REQUIRED for col width classes to work!**
      - All theme CSS files include this property
      - Without it, browser ignores col width settings (standard CSS behavior)
    - **CRITICAL: Do NOT use `<table width="100%">` HTML attribute!**
      - Use CSS instead (already in themes)
    - Use `class="w-35"` instead of `style="width: 35%"` (Marp sanitizes inline styles)
    - Available classes: w-20, w-25, w-30, w-35, w-40, w-50, w-60, w-65, w-70, w-75, w-80
    - Reference: snippets/table.html

[7] Logo Injection (if theme uses logo)
    - Theme CSS uses `{{LOGO_BASE64}}` placeholder
    - Run: scripts/inject-logo.sh <output.md> to inject logo
    - Custom logo: scripts/inject-logo.sh <output.md> --logo path/to/logo.png
    - Script converts PNG to base64 data URI and replaces placeholder

[8] Export (if format != md)
    - Run: scripts/export.sh <output.md> --format <format>
    - Logo injection handled automatically by export script
    - Return final file path
```

## Reference Loading Strategy

効率的なコンテキスト使用のため、必要なファイルのみを読み込む：

```
references/
├── README.md              # Always load (概要・選択ガイド)
├── design-guidelines.md   # Always load (デザインルール)
├── tones.md               # Load when tone customization needed
├── structures/            # Load ONE based on --type
│   ├── problem-solution.md
│   ├── product-intro.md
│   ├── tech-talk.md
│   ├── tutorial.md
│   └── lightning-talk.md
├── themes/                # Load ONE based on --theme
│   ├── minimal.css
│   ├── corporate.css
│   └── colorful.css
└── snippets/              # Load as needed during generation
    ├── kpi-cards.html
    ├── comparison.html
    ├── flow.html
    ├── testimonial.html
    └── table.html         # Use for ALL tables (NOT Markdown)
```

## Output Example

```markdown
---
marp: true
paginate: true
style: |
  /* Full theme CSS with all layout classes */
---

<!-- _class: cover -->
<!-- _paginate: false -->

# 勤怠データ自動集計システム

入退室ログ×カオナビ連携で
**作業時間96%削減**

株式会社playpark

---

<!-- _class: agenda -->

## 本日のアジェンダ

- 導入前の課題
- ソリューション概要
- 導入効果
- 技術構成

---

## 導入効果

<div class="kpi-container">
<div class="kpi-card">
<div class="number">96%</div>
<div class="label">作業時間削減</div>
<div class="change">2時間→5分</div>
</div>
<div class="kpi-card">
<div class="number">0件</div>
<div class="label">転記ミス</div>
<div class="change">100%解消</div>
</div>
<div class="kpi-card">
<div class="number">即時</div>
<div class="label">レポート作成</div>
<div class="change">3日→即時</div>
</div>
</div>

---

<!-- _class: closing -->

# ご清聴ありがとうございました

**お問い合わせ**
contact@playpark.co.jp
```

## References

### Core Files (Always Loaded)
- `references/README.md` - Overview and selection guide
- `references/design-guidelines.md` - Design rules, layout classes, detection rules

### Conditional Files
- `references/structures/{type}.md` - Slide structure pattern for selected type
- `references/themes/{theme}.css` - CSS theme for selected theme
- `references/tones.md` - Voice tone definitions
- `references/snippets/*.html` - HTML component templates

### Assets
- `assets/logo.png` - Company logo (injected via script)

### Scripts
- `scripts/inject-logo.sh` - Inject logo as base64 data URI into slides/CSS
- `scripts/export.sh` - Export slides to PDF/HTML/PPTX

## Logo Customization

Theme CSSでは `{{LOGO_BASE64}}` プレースホルダーを使用。実際のロゴはスクリプトで注入。

### For Skill Distribution

スキルを配布する際は、受け取り側で以下を実行：

```bash
# 1. assets/logo.png を自社ロゴに差し替え
cp /path/to/my-logo.png assets/logo.png

# 2. スライド生成時に自動で注入される
# または手動で注入
scripts/inject-logo.sh output.md
```

### Multiple Logo Variants

白抜きロゴなど、複数バリアントを使う場合：

```bash
# カスタムロゴを指定
scripts/inject-logo.sh slides.md --logo assets/logo-white.png -o slides-dark.md
```

### Placeholder in Theme CSS

```css
:root {
  /* Placeholder - replaced by inject-logo.sh */
  --logo-image: url('{{LOGO_BASE64}}');
}
```

## Examples

```bash
# 対話的に選択（デフォルト）
/marp-slide ./case-study.md

# タイプ指定（Tone/Themeは推奨から自動設定）
/marp-slide ./case-study.md --type problem-solution

# 全て指定（選択フローをスキップ）
/marp-slide ./tech-post.md --type tech-talk --tone casual --theme minimal

# 選択フローをスキップ（デフォルト値で即生成）
/marp-slide ./quick-note.md --skip-selection

# PDF出力
/marp-slide ./slides.md --format pdf -o ./presentation.pdf

# PowerPoint出力
/marp-slide ./report.md --type problem-solution --format pptx
```