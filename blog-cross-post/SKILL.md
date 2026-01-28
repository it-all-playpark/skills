---
name: blog-cross-post
description: |
  Convert playpark blog articles to Zenn/Qiita format with value-first approach.
  Use when: (1) user wants to cross-post blog articles to external platforms,
  (2) keywords like "Zenn", "Qiita", "クロスポスト", "外部公開",
  (3) user has content/blog/ MDX file and wants platform-specific output.
  Accepts args: <slug-or-path> [--platform zenn|qiita|both] [--output path]
user-invocable: true
---

# Blog Cross-Post

playpark blog記事をZenn/Qiita向け**コア版**に変換。

## コンセプト: 価値提供型Cross-Post

**「誘導記事」ではなく「コア版 + 深掘り導線」**

| 項目 | 説明 |
|-----|------|
| Zenn/Qiita版 | その場で学びが完結する（読者満足） |
| 公式版との差 | 公式はより詳細・応用・複数パターン |
| 導線 | 「さらに深掘りしたい方へ」で公式誘導 |

## 対象カテゴリ

| Category | Cross-post | 理由 |
|----------|-----------|------|
| tech-tips | ✅ 対象 | エンジニア向け、Zenn/Qiita適性高 |
| lab-reports | ✅ 対象 | 技術実験、Zenn読者に刺さる |
| solutions | ❌ 対象外 | ビジネス層向け、プラットフォーム不適 |
| case-studies | ❌ 対象外 | ビジネス層向け、プラットフォーム不適 |

**solutions/case-studiesが指定された場合**: エラーを返し、対象外であることを説明。

## プラットフォーム差別化戦略

**同一内容の複数投稿はSEO効果が分散** → ZennとQiitaで切り口を変える

### ユーザー特性

| Platform | 読者層 | 好む切り口 | 記事の特徴 |
|----------|--------|-----------|-----------|
| Zenn | モダン技術志向、実装重視 | **How（実装パターン）** | コード中心、実践的、すぐ使える |
| Qiita | 幅広い技術者、背景理解重視 | **Why（技術選定理由）** | 解説中心、比較検討、判断材料 |

### カテゴリ別の切り口

| Category | Zenn版 | Qiita版 |
|----------|--------|---------|
| tech-tips | 実装パターン・コード例中心 | 技術選定理由・比較検討中心 |
| lab-reports | 検証結果・発見した知見 | 実験の背景・動機・Why |

### 具体例

**tech-tips「Claude Code Skills設計」の場合:**

| | Zenn | Qiita |
|--|------|-------|
| タイトル | 「Skills設計パターン集」 | 「なぜSkillsでこう設計するのか」 |
| 冒頭 | 「こう書くと動く」 | 「この設計にした理由」 |
| 本文 | コード例 → 解説 | 課題 → 選択肢 → 判断基準 |
| 読後感 | 「すぐ使える！」 | 「なるほど、そういうことか」 |

**lab-reports「AI Code Review検証」の場合:**

| | Zenn | Qiita |
|--|------|-------|
| タイトル | 「AI Code Reviewで分かった3つの知見」 | 「なぜAI Code Reviewを検証したか」 |
| 冒頭 | 「検証したらこうだった」 | 「こういう課題があった」 |
| 本文 | 結果 → データ → 結論 | 背景 → 仮説 → 検証設計 |
| 読後感 | 「知見が得られた」 | 「検証の意図が分かった」 |

## Usage

```
/blog-cross-post <slug-or-path> [--platform zenn|qiita|both] [--output path]
```

## Init

```bash
bash ~/.claude/skills/blog-cross-post/scripts/resolve-source.sh <slug-or-path>
```

## Workflow

1. **Init**: resolve-source.sh → `{source_path, slug, seed_path, original_url}`
2. **Category Check**: 元記事の `category` を確認
   - tech-tips/lab-reports → 続行
   - solutions/case-studies → エラー終了
3. **Read**: 元記事 + seed（あれば）
4. **Extract Core**: 記事の核心部分を特定
   - 主要な学び（1-2個）
   - 動作するコード例
   - 重要な結論
5. **Identify Depth**: 公式版にしかない深掘り要素を特定
   - 複数パターン比較
   - 実運用知見・失敗談
   - 応用・発展的内容
6. **Generate**: コア版 + 深掘り導線
7. **Output**: 表示 or --output へ書き出し

## コア版の設計原則

### 「完結」と「深掘り」のバランス

```
コア版で提供するもの:
├── 問題提起（読者の共感）
├── 解決アプローチの概要
├── 動作するコード例（1-2個）
├── 主要な結論
└── 【ここで記事として完結】

深掘り導線で示すもの:
├── 「公式版ではさらに...」
│   ├── 複数パターンの比較
│   ├── 実運用での知見
│   ├── 失敗談とその対処
│   └── 応用・発展的な内容
└── 具体的に何が読めるかを明示
```

### NGパターン

| NG | 理由 | OK |
|----|------|-----|
| 「続きは公式で」 | 途中で切れてる感 | 「さらに詳しく知りたい方へ」 |
| 概要だけで終わる | 読者不満 | コード例まで含める |
| 公式と同一内容 | 差別化なし | コア vs 詳細の明確な差 |

## 文字数ガイドライン

| セクション | Zenn | Qiita |
|-----------|------|-------|
| 冒頭 | 150-200字 | 150-200字 |
| 本文 | 1000-1500字 | 800-1200字 |
| 深掘り導線 | 200-300字 | 200-300字 |
| **合計** | **1500-2500字** | **1200-2000字** |

## References

- `references/backlink-templates.md` - 記事テンプレート・深掘り導線
- `references/conversion-rules.md` - 変換ルール
- `references/seo-guidelines.md` - SEO詳細
