# Problem-Solution Pattern (10-15 slides)

導入事例・課題解決型のプレゼン構造。**営業資料の定番パターン**。

## Structure

```
1. Cover (cover)
   - インパクトのあるタイトル
   - サブタイトルで成果を示唆
   - 会社名/発表者名

2. Agenda (agenda)
   - 4-5項目の目次
   - カード風デザイン

3. Problem Overview
   - 課題の概要を1スライドで
   - 3点以内に絞る

4-5. Problem Details (通常 or two-col)
   - 各課題の詳細
   - 数値で痛みを表現

6. Solution Overview (flow)
   - システム構成図
   - フローダイアグラム

7-8. Solution Details (two-col)
   - 主要機能の説明
   - スクリーンショット活用

9. Results - KPI (kpi-cards)
   - 定量的成果を大きく表示
   - Before/After比較

10. Results - Comparison (comparison)
    - ビジュアルなBefore/After

11. Qualitative Results
    - 定性的な成果
    - 箇条書き3点

12. Testimonial (testimonial)
    - お客様の声
    - 引用形式

13. Summary (lead)
    - 3点以内の要約

14. Closing (closing)
    - Thank you
    - 連絡先・CTA
```

## Example

```markdown
---
marp: true
theme: default
paginate: true
style: |
  /* corporate theme styles here */
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

## 導入前の課題

### 管理部門の業務負荷が限界に

1. **毎日2時間**の手作業集計
2. **3日遅れ**のレポート作成
3. **月3件**の転記ミス

---

<!-- _class: comparison -->

## 導入効果：Before / After

<div class="before">
<h3>Before</h3>
<ul>
<li>手作業で2時間/日</li>
<li>転記ミス月3件</li>
<li>レポート作成3日</li>
</ul>
</div>

<div class="arrow">→</div>

<div class="after">
<h3>After</h3>
<ul>
<li>自動で5分/日</li>
<li>転記ミス0件</li>
<li>レポート即時</li>
</ul>
</div>

---

## 定量的成果

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

<!-- _class: testimonial -->

<blockquote>
以前は集計作業に追われておりましたが、
現在は分析業務に注力できるようになりました。
</blockquote>

<div class="author">
<strong>管理部門 ご担当者様</strong>
製造業 A社
</div>

---

<!-- _class: closing -->

# ご清聴ありがとうございました

**お問い合わせ**
contact@playpark.co.jp
```
