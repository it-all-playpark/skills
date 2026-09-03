# Professional Design Guidelines

プロのデザイナー基準に基づく情報密度ガイドライン。

---

## 🔴 CRITICAL RULES (MUST)

### First Slide Rule

**`</style>` の直後に `---` を入れない。1枚目のコンテンツを直接続ける。**

```markdown
</style>

<!-- _class: cover -->   ← ここに---を入れない
# タイトル
```

### 6x6 Rule (情報密度の原則)

| 項目 | 推奨値 | NG例 |
|------|--------|------|
| 1スライドの箇条書き | **最大6行** | 10行以上の長いリスト |
| 1行の単語数 | **最大6語程度** | 長文を箇条書きに詰め込む |
| フォントサイズ種類 | **最大3種類** | h1〜h6全部使う |
| 1スライドの要素 | **1メッセージ** | 複数トピックを1枚に |

### Closing Slide Template

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

---

## 🟡 CLASS REFERENCE (PRIMARY)

### Layout Classes (Slide Level: `<!-- _class: xxx -->`)

| Class | Purpose | When to Use |
|-------|---------|-------------|
| `cover` | タイトルスライド | 最初のスライド |
| `lead` | セクション区切り | 章の切り替え |
| `agenda` | 目次 | 2枚目（目次表示時） |
| `gradient-bg` | 通常コンテンツ背景 | **ほぼ全てのコンテンツスライド** |
| `accent-gradient` | ハイライト背景 | Key Takeaway、重要メッセージ |
| `two-col` | 2カラム | 画像+テキスト、比較 |
| `comparison` | Before/After | 導入前後の比較 |
| `testimonial` | お客様の声 | 引用・推薦文 |
| `flow` | フロー図 | ステップ説明 |
| `closing` | 締めスライド | 最後のスライド |

### Component Classes (Element Level: `<div class="xxx">`)

| Class | Purpose | Combine With |
|-------|---------|--------------|
| `lab-card` | 情報カード（破線） | `gradient-bg` |
| `lab-card accent` | 強調カード（青破線） | `gradient-bg` |
| `sticky-note {color}` | 付箋カード | `sticky-grid` |
| `sticky-grid` | 付箋4列グリッド | `gradient-bg` |
| `sticky-grid two-col` | 付箋2列 | `gradient-bg` |
| `sticky-grid three-col` | 付箋3列 | `gradient-bg` |
| `kpi-container` + `kpi-card` | KPI数値表示 | `gradient-bg` |
| `flow-container` + `flow-step` | フローステップ | `gradient-bg` or `flow` |

### Sticky Note Colors

| Class | Color | Best For |
|-------|-------|----------|
| `sticky-note blue` | #3498db | 主要機能、メイン |
| `sticky-note yellow` | #ffd93d | 注目、ハイライト |
| `sticky-note pink` | #ff6b9d | アクセント、差別化 |
| `sticky-note green` | #6bcb77 | 成功、効果、結果 |

### Color Variables (CSS)

| Variable | Color | Use Case |
|----------|-------|----------|
| `--color-primary` | #3498db | 見出し、リンク |
| `--color-accent` | #f39c12 | CTA、強調ボタン |
| `--color-reaction-pink` | #ff6b9d | アジェンダ1番目 |
| `--color-reaction-purple` | #9b59b6 | アジェンダ2番目 |
| `--color-reaction-green` | #6bcb77 | アジェンダ4番目 |
| `--color-reaction-yellow` | #ffd93d | ハイライト |
| `--color-reaction-orange` | #ff8c42 | 警告 |

---

## 🟢 EXAMPLES (REFERENCE)

### lab-card Example

```markdown
---
<!-- _class: gradient-bg -->

# 主要機能

<div class="lab-card">

**機能1: 自動分析**

AIがデータを自動で分析し、インサイトを抽出します。

</div>

<div class="lab-card accent">

**おすすめ: リアルタイムダッシュボード**

24時間365日、最新のデータを可視化。

</div>
```

### Sticky Note Example

```markdown
---
<!-- _class: gradient-bg -->

# 私たちの強み

<div class="sticky-grid">
  <div class="sticky-note blue">
    <div class="icon">🔬</div>
    <h3>実験マインド</h3>
    <p>仮説と検証を繰り返しながら挑みます。</p>
  </div>
  <div class="sticky-note yellow">
    <div class="icon">⚡</div>
    <h3>スピード実装</h3>
    <p>48時間以内の迅速な対応。</p>
  </div>
  <div class="sticky-note pink">
    <div class="icon">✨</div>
    <h3>アソビゴコロ</h3>
    <p>楽しみながらクリエイティブに。</p>
  </div>
  <div class="sticky-note green">
    <div class="icon">👥</div>
    <h3>伴走支援</h3>
    <p>パートナーとして共に歩みます。</p>
  </div>
</div>
```

---

## 📊 AUTO-DETECTION RULES

### Content → Layout Mapping

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

### Type Detection Keywords

| Type | Primary Keywords |
|------|-----------------|
| problem-solution | 課題, 問題, 解決, 導入, 効果 |
| product-intro | 機能, 特徴, サービス, 製品, 価格 |
| tech-talk | 実装, コード, 技術, API, アーキテクチャ |
| tutorial | 手順, ステップ, 方法, 始め方, 入門 |
| lightning-talk | (length < 500) |

### Length-Based Fallback

| Content Length | Default Type |
|----------------|--------------|
| < 500 chars | lightning-talk |
| 500-2000 chars | tech-talk |
| > 2000 chars | problem-solution |

---

## 📏 TYPOGRAPHY & TIMING

### Typography Standards

| 用途 | サイズ目安 |
|------|-----------|
| タイトル（Cover） | h1: 2.2em |
| スライドタイトル | h1: 1.8em |
| セクション見出し | h2: 1.4em |
| 本文・箇条書き | p, li: 0.95em |
| 補足テキスト | .label: 0.85em |

### Reading Time per Slide

| スライドタイプ | 想定時間 | 内容量目安 |
|---------------|---------|-----------|
| Cover | 10-15秒 | タイトル + 1行 |
| Agenda | 20-30秒 | 4-5項目 |
| Content | 45-60秒 | 箇条書き3-5項目 |
| KPI/数値 | 30-45秒 | 3指標まで |
| Comparison | 45-60秒 | Before/After各3項目 |
| Testimonial | 30-45秒 | 1引用 + 出典 |
| Closing | 15-20秒 | Thank you + 連絡先 |

### Table Guidelines

**テーブルはHTMLで記述（Markdownは列幅制御不可）**

| 列数 | 推奨幅配分 |
|------|-----------|
| 2列 | 60%/40% または 50%/50% |
| 3列 | 40%/30%/30% |
| 4列 | 25%/25%/25%/25% |

Reference: `snippets/table.html`
