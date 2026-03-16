# Conversion Rules

playpark blog (MDX) → Zenn/Qiita 変換ルール詳細。

## プラットフォーム差別化の原則

**ZennとQiitaで切り口を変える** - 同一内容の重複投稿を避ける

### タイトルの付け方

| Platform | パターン | 例 |
|----------|---------|-----|
| **Zenn** | 課題・体験ベース | 「{課題}で踏んだ地雷と回避パターン」「{テーマ}を{条件}試して分かった現実」 |
| **Qiita** | Why型（理由・背景） | 「なぜ{技術名}でこう実装するのか」「なぜ{テーマ}を検証したか」 |

### 構成の違い

| | Zenn | Qiita |
|--|------|-------|
| 冒頭 | 課題の共感（読者の痛み） | 学べること（背景先行） |
| 本文開始 | 課題 → 解決策 + 判断理由 | 課題・背景から |
| コード比率 | 中（コード + なぜこう書くか） | 少なめ |
| 解説比率 | 中（判断・持論を含む） | 多め |
| 読後感 | 「判断基準ごと持ち帰れた」 | 「判断できる」 |
| トーン | 個人の体験として語る | 技術解説 |
| フッター | 企業紹介なし（個人ブログ文化） | 企業紹介あり |

### カテゴリ別の切り口

| Category | Zenn版 | Qiita版 |
|----------|--------|---------|
| tech-tips | 課題共感→実装+判断理由→持論 | 技術選定理由・比較検討中心 |
| lab-reports | 課題共感→検証結果+解釈→持論 | 実験の背景・動機・Why |

## Frontmatter Conversion

### Zenn Format

```yaml
---
title: "記事タイトル"
emoji: "🚀"
type: "tech"
topics: ["nextjs", "react", "typescript"]
published: false
---
```

| Field | Source | Rule |
|-------|--------|------|
| title | title | そのまま使用（【】は残す） |
| emoji | category | カテゴリから自動選択 |
| type | category | tech-tips/lab-reports → tech, その他 → idea |
| topics | tags | 小文字化、最大5個 |
| published | - | false（下書きとして投稿、確認後に手動でtrueに変更） |

> **Note**: Zenn は `canonical_url` を frontmatter でサポートしていない（[Issue #78](https://github.com/zenn-dev/zenn-community/issues/78) 未実装）。テキストリンクによる帰属表示が唯一の手段。

### Qiita Format

```yaml
---
title: "記事タイトル"
tags:
  - name: Next.js
    version: "16"
  - name: React
private: false
---
```

| Field | Source | Rule |
|-------|--------|------|
| title | title | そのまま使用 |
| tags | tags | タグ名とバージョン分離（可能なら） |
| private | - | false |

## Emoji Mapping by Category

| Category | Emoji Options |
|----------|---------------|
| tech-tips | 🛠️ 💡 ⚙️ 🔧 |
| solutions | ✅ 💼 📊 🎯 |
| case-studies | 📝 🏆 💪 🌟 |
| lab-reports | 🧪 🔬 🚀 ⚡ |

選択基準: タイトルのキーワードに基づく（自動化、AI→🤖、Web→🌐等）

## Tag Transformation

### Zenn Topics

```
# Original tags
- Next.js
- React 19
- TypeScript
- MDX
- フロントエンド
- 業務自動化

# Zenn topics (lowercase, ASCII preferred)
topics: ["nextjs", "react", "typescript", "mdx", "frontend"]
```

変換ルール:
1. 小文字化
2. スペース → なし
3. バージョン番号削除
4. 日本語 → 英語に置換（可能な場合）
5. 最大5個

### Qiita Tags

```yaml
tags:
  - name: Next.js
    version: "16"
  - name: React
  - name: TypeScript
  - name: MDX
```

変換ルール:
1. 元のタグ名を保持
2. バージョン情報があれば分離
3. 最大5個

## Component Transformations

### Mermaid

```mdx
<!-- Original -->
<Mermaid chart={`
%%{init: {'theme': 'neutral'}}%%
flowchart LR
    A --> B
`} />

<!-- Transformed -->
```mermaid
flowchart LR
    A --> B
```
```

注意: `%%{init: ...}%%` は削除（Zenn/Qiitaで非対応の場合あり）

### Interactive Components

```mdx
<!-- Original -->
<InteractiveDemo prop="value" />

<!-- Transformed -->
:::message
このセクションには元記事でインタラクティブなデモがあります。
[元記事で確認する](https://www.playpark.co.jp/blog/{slug})
:::
```

### Code Blocks

言語指定を維持:

```mdx
<!-- Original -->
```typescript
const x = 1;
```

<!-- Transformed (同じ) -->
```typescript
const x = 1;
```
```

### Tables

Markdown表はそのまま使用可能。

## Image Path Transformation

### Original

```markdown
![画像](/blog/2026-01-22-image.webp)
```

### Zenn

```markdown
![画像](https://www.playpark.co.jp/blog/2026-01-22-image.webp)
```

### Qiita

```markdown
![画像](https://www.playpark.co.jp/blog/2026-01-22-image.webp)
```

相対パス → 絶対URL（元サイトのドメイン）

## Link Transformation

### Internal Links

```markdown
<!-- Original -->
[お問い合わせはこちら](/contact)

<!-- Transformed -->
[お問い合わせはこちら](https://www.playpark.co.jp/contact)
```

### Anchor Links

```markdown
<!-- Original -->
[セクション](#section-name)

<!-- Transformed (同じ) -->
[セクション](#section-name)
```

## Content Structure

### Remove/Transform

| Element | Action |
|---------|--------|
| `→ [お問い合わせ](/contact)` | Remove (replaced by CTA section) |
| Front matter description | Remove (Zenn/Qiita don't use) |
| Front matter image | Remove (OGP自動生成) |

### Keep

| Element | Note |
|---------|------|
| Headings | そのまま |
| Lists | そのまま |
| Blockquotes | そのまま |
| Code blocks | 言語指定維持 |
| Tables | そのまま |

## Canonical URL Handling

### Zenn

**テキストリンクのみ**（`canonical_url` は [Issue #78](https://github.com/zenn-dev/zenn-community/issues/78) で要望あるが未実装）

記事末尾に追加:

```markdown
---

**この記事は [playpark Blog](https://www.playpark.co.jp/blog/{slug}) からの転載です。**
```

### Qiita

**テキストリンクのみ**（APIに canonical_url フィールドなし）

記事冒頭に追加:

```markdown
> この記事は [playpark Blog](https://www.playpark.co.jp/blog/{slug}) からの転載です。

---

（本文）
```
