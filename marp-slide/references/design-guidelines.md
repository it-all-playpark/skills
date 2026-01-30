# Professional Design Guidelines

プロのデザイナー基準に基づく情報密度ガイドライン。

## 6x6 Rule (情報密度の原則)

| 項目 | 推奨値 | NG例 |
|------|--------|------|
| 1スライドの箇条書き | **最大6行** | 10行以上の長いリスト |
| 1行の単語数 | **最大6語程度** | 長文を箇条書きに詰め込む |
| フォントサイズ種類 | **最大3種類** | h1〜h6全部使う |
| 1スライドの要素 | **1メッセージ** | 複数トピックを1枚に |

## Typography Standards

| 用途 | サイズ目安 | Marp設定 |
|------|-----------|----------|
| タイトル（Cover） | 40pt相当 | h1: 2.2em |
| スライドタイトル | 32pt相当 | h1: 1.8em |
| セクション見出し | 28pt相当 | h2: 1.4em |
| 本文・箇条書き | 18-20pt相当 | p, li: 0.95em |
| 補足テキスト | 14-16pt相当 | .label: 0.85em |

## Whitespace Guidelines

```
┌─────────────────────────────────────┐
│                70px                 │  ← 上部マージン
│  ┌───────────────────────────────┐  │
│  │                               │  │
│1 │                               │ 1│  ← 左右100px
│0 │      コンテンツエリア         │ 0│
│0 │                               │ 0│
│p │                               │ p│
│x │                               │ x│
│  │                               │  │
│  └───────────────────────────────┘  │
│                70px                 │  ← 下部マージン
└─────────────────────────────────────┘
```

## Content Density Rules

**DO (推奨)**
- 1スライド = 1メッセージ
- 箇条書きは3〜5項目
- 数値は大きく、ラベルは小さく
- 余白を恐れない

**DON'T (避ける)**
- 箇条書き7項目以上
- 長文の段落
- フォントサイズの乱用
- 画像とテキストの詰め込み

## Reading Time per Slide

| スライドタイプ | 想定時間 | 内容量目安 |
|---------------|---------|-----------| 
| Cover | 10-15秒 | タイトル + 1行サブタイトル |
| Agenda | 20-30秒 | 4-5項目 |
| Content (通常) | 45-60秒 | 箇条書き3-5項目 |
| KPI/数値 | 30-45秒 | 3指標まで |
| Comparison | 45-60秒 | Before/After各3項目 |
| Testimonial | 30-45秒 | 1引用 + 出典 |
| Closing | 15-20秒 | Thank you + 連絡先 |

## Layout Classes Reference

| Class | Use Case | Description |
|-------|----------|-------------|
| `cover` | タイトルスライド | フルスクリーン、中央配置、グラデーション背景 |
| `lead` | セクション区切り | 中間のセクション区切り、色付き背景 |
| `agenda` | 目次 | 番号付きリスト、カード風デザイン |
| `two-col` | 2カラム | 左右均等分割、比較や画像+テキストに |
| `comparison` | Before/After | 3カラム（左・矢印・右）で比較表現 |
| `testimonial` | お客様の声 | 大きな引用符、中央配置 |
| `flow` | フロー図 | 横並びステップ、矢印接続 |
| `closing` | 締めスライド | Thank you、連絡先、CTA |

## Marp Directives Reference

```markdown
<!-- Common directives -->
marp: true
theme: default|gaia|uncover
paginate: true|false
header: 'Header text'
footer: 'Footer text'
backgroundColor: #color
backgroundImage: url('path')

<!-- Per-slide directives -->
<!-- _class: cover -->        # Title/cover slide
<!-- _class: lead -->         # Section break
<!-- _class: two-col -->      # Two column layout
<!-- _class: comparison -->   # Before/After
<!-- _class: testimonial -->  # Quote/voice
<!-- _class: agenda -->       # Table of contents
<!-- _class: closing -->      # Thank you slide
<!-- _paginate: false -->     # Hide page number
<!-- _backgroundColor: X -->  # Slide-specific bg
```

## Table Guidelines (IMPORTANT)

**テーブルはMarkdownではなくHTMLで記述すること。**

### Why HTML Tables?

| Markdown Table | HTML Table |
|----------------|------------|
| 列幅が自動調整され制御不可 | `colgroup`で明示的に列幅指定可能 |
| 2列だと右側に大きな空白 | 幅100%で均等に配置 |
| セル内の配置制御が限定的 | `text-align`, `vertical-align`が自由 |

### HTML Table Pattern

```html
<table>
  <colgroup>
    <col style="width: 60%">
    <col style="width: 40%">
  </colgroup>
  <thead>
    <tr><th>項目</th><th>詳細</th></tr>
  </thead>
  <tbody>
    <tr><td>内容</td><td><strong>値</strong></td></tr>
  </tbody>
</table>
```

### Column Width Guidelines

| 列数 | 推奨幅配分 |
|------|-----------|
| 2列 | 60%/40% または 50%/50% |
| 3列 | 40%/30%/30% または 均等 |
| 4列 | 25%/25%/25%/25% |

**Reference:** `references/snippets/table.html`

---

## Content Detection Rules

スライド生成時、以下のルールでレイアウトを自動選択：

| Content Pattern | Auto Layout |
|-----------------|-------------|
| 数値 + "削減/改善/向上" | `kpi-cards` |
| "Before/After" or "導入前/後" | `comparison` |
| "お客様の声" or 引用形式 | `testimonial` |
| ステップ形式（1→2→3） | `flow` |
| 画像 + 説明テキスト | `two-col` |
| "目次/アジェンダ" | `agenda` |
| 最初のスライド | `cover` |
| 最後のスライド | `closing` |

## Type Detection Rules

### Keyword-Based Detection

| Type | Primary Keywords | Secondary Keywords |
|------|-----------------|-------------------|
| problem-solution | 課題, 問題, 解決, 導入 | 効果, 削減, 改善, Before/After |
| product-intro | 機能, 特徴, サービス, 製品 | 価格, プラン, デモ, 使い方 |
| tech-talk | 実装, コード, 技術, API | アーキテクチャ, 設計, ライブラリ |
| tutorial | 手順, ステップ, 方法, 始め方 | インストール, 設定, 学習, 入門 |
| lightning-talk | (length < 500) | TL;DR, 要点, 結論 |

### Fallback Rules

キーワードマッチがない場合の推定：

| Content Length | Default Type |
|----------------|--------------| 
| < 500 chars | lightning-talk |
| 500-2000 chars | tech-talk |
| > 2000 chars | problem-solution |
