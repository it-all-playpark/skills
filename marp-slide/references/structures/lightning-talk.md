# Lightning-Talk Pattern (5-8 slides)

LT・短時間発表向け。**1スライド30-45秒**。

## Structure

```
1. Cover (cover)
   - キャッチーなタイトル
   - 名前・所属

2. Hook / Problem
   - 聴衆の興味を引く導入
   - 1スライドで課題を明確に

3-4. Solution
   - コア解決策
   - 最小限のコード/図解

5-6. Key Takeaway (kpi-cards)
   - 最も伝えたいこと
   - 具体的な数値や結果

7. Try It!
   - 今日から試せること
   - リンク・リソース

8. Closing (closing)
   - SNS/連絡先
```

## Example

```markdown
---
marp: true
theme: default
paginate: true
---

<!-- _class: cover -->
<!-- _paginate: false -->

# 5分でわかるBun

Node.jsより速い新ランタイム

@username

---

## こんな経験ありません？

### npm installが遅すぎる問題

```bash
$ npm install
# ...5分経過...
added 1,247 packages in 312s
```

**→ Bunなら10秒で終わります**

---

## Bunとは

### オールインワン JavaScript ランタイム

- ⚡ Node.js互換で**3倍速い**
- 📦 npm install が**20倍速い**
- 🔧 バンドラー・テストランナー内蔵

```bash
# インストール
curl -fsSL https://bun.sh/install | bash
```

---

## 速度比較

<div class="kpi-container">
<div class="kpi-card">
<div class="number">3x</div>
<div class="label">実行速度</div>
<div class="change">vs Node.js</div>
</div>
<div class="kpi-card">
<div class="number">20x</div>
<div class="label">インストール</div>
<div class="change">vs npm</div>
</div>
<div class="kpi-card">
<div class="number">100%</div>
<div class="label">互換性</div>
<div class="change">Node.js API</div>
</div>
</div>

---

## 今日から試せること

### 3ステップで移行

```bash
# 1. インストール
curl -fsSL https://bun.sh/install | bash

# 2. 既存プロジェクトで実行
cd your-project
bun install  # npm installの代わり
bun run dev  # npm run devの代わり

# 3. 速さを体感する 🚀
```

---

<!-- _class: closing -->

# Try Bun Today!

**公式サイト**
https://bun.sh

@username
```

## Tips for Lightning Talks

### 時間配分（5分の場合）

| スライド | 時間 |
|---------|------|
| Cover | 15秒 |
| Hook/Problem | 45秒 |
| Solution x2 | 90秒 |
| Key Takeaway | 45秒 |
| Try It | 30秒 |
| Closing | 15秒 |

### ポイント

- **1メッセージに絞る** - 複数伝えたいことがあっても1つに
- **コードは最小限** - 読める量に収める（10行以下）
- **数値で示す** - 「速い」より「3倍速い」
- **アクションを明確に** - 「今日試せること」を入れる
