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

## Closing Slide Template

```markdown
---
<!-- _class: closing -->

# Thank You

お気軽にご相談ください

*playpark LLC*

https://www.playpark.co.jp/contact

---
```

**Notes:**
- 会社名は `*playpark LLC*` (emphasis) で記述 → アクセントカラーで目立つ
- または `<span class="company">playpark LLC</span>` で明示的にスタイル適用
- URL はそのまま記述（自動リンク化）

## Layout Classes Reference

| Class | Use Case |
|-------|----------|
| `cover` | タイトルスライド（中央配置、グラデーション背景） |
| `lead` | セクション区切り（色付き背景） |
| `agenda` | 目次（カード風デザイン） |
| `two-col` | 2カラム（画像+テキスト、比較） |
| `comparison` | Before/After（3カラム） |
| `testimonial` | お客様の声（大きな引用符） |
| `flow` | フロー図（横並びステップ） |
| `closing` | 締めスライド（Thank you、CTA） |

## Table Guidelines

**テーブルはHTMLで記述（Markdownは列幅制御不可）**

| 列数 | 推奨幅配分 |
|------|-----------|
| 2列 | 60%/40% または 50%/50% |
| 3列 | 40%/30%/30% または 均等 |
| 4列 | 25%/25%/25%/25% |

Reference: `snippets/table.html`

## Content Detection Rules

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

| Content Length | Default Type |
|----------------|--------------|
| < 500 chars | lightning-talk |
| 500-2000 chars | tech-talk |
| > 2000 chars | problem-solution |