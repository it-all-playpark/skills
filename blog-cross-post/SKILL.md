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
| Zenn | モダン技術志向、個人開発者文化 | **Deep How + 意見（実装 + 判断 + 持論）** | 課題共感→実装→なぜこう書くか、書き手の体験として語る |
| Qiita | 幅広い技術者、背景理解重視 | **Why（技術選定理由）** | 解説中心、比較検討、判断材料 |

### Zenn記事の設計思想

Zennで伸びる記事は「コードを貼って終わり」ではなく、**書き手の判断・意見・体験**が入ったディープダイブ記事。
薄いHow-toはZenn上に既に溢れており、差別化できない。

**Zenn記事の3要素:**
1. **課題の共感** — 読者が「あるある」と感じる導入
2. **実装 + 判断理由** — コードだけでなく「なぜこう書くか」を添える
3. **持論・トレードオフ** — 他の方法との比較、書き手としての意見

### カテゴリ別の切り口

| Category | Zenn版 | Qiita版 |
|----------|--------|---------|
| tech-tips | 課題共感→実装+判断理由→持論 | 技術選定理由・比較検討中心 |
| lab-reports | 課題共感→検証結果+解釈→得られた持論 | 実験の背景・動機・Why |

### 具体例

**tech-tips「Claude Code Skills設計」の場合:**

| | Zenn | Qiita |
|--|------|-------|
| タイトル | 「Skills設計で踏んだ3つの地雷と回避パターン」 | 「なぜSkillsでこう設計するのか」 |
| 冒頭 | 「こういう場面でハマりませんか？」 | 「この設計にした理由」 |
| 本文 | 課題 → コード例 + なぜこう書くか → 他の方法との比較 | 課題 → 選択肢 → 判断基準 |
| 読後感 | 「判断基準ごと持ち帰れた」 | 「なるほど、そういうことか」 |

**lab-reports「AI Code Review検証」の場合:**

| | Zenn | Qiita |
|--|------|-------|
| タイトル | 「AI Code Reviewを3ヶ月運用して分かった現実」 | 「なぜAI Code Reviewを検証したか」 |
| 冒頭 | 「期待と現実のギャップ、ありませんか？」 | 「こういう課題があった」 |
| 本文 | 結果 → データ → 解釈 + 「自分はこう使うことにした」 | 背景 → 仮説 → 検証設計 |
| 読後感 | 「リアルな判断材料が手に入った」 | 「検証の意図が分かった」 |

## Usage

```
/blog-cross-post <slug-or-path> [--platform zenn|qiita|both] [--output path]
```

## Init

```bash
bash $SKILLS_DIR/blog-cross-post/scripts/resolve-source.sh <slug-or-path>
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

- `references/cross-post-strategy.md` - 差別化方針・コア版設計原則・共通変換ルール
- `$SKILLS_DIR/zenn-publish/references/content-guide.md` - Zennテンプレート・変換ルール・SEO
- `$SKILLS_DIR/qiita-publish/references/content-guide.md` - Qiitaテンプレート・変換ルール・SEO

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-cross-post success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log blog-cross-post failure \
  --error-category <category> --error-msg "<message>"
```
