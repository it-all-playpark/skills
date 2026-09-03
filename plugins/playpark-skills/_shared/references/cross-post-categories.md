# Cross-Post Categories

クロスポスト対象カテゴリの定義。seed-to-blog, cross-post-publish で共有。

## 対象判定

| Category     | Cross-post | Platform    | 理由                   |
| ------------ | ---------- | ----------- | ---------------------- |
| tech-tips    | ✅ 対象    | Zenn, Qiita | エンジニア向け技術Tips |
| lab-reports  | ✅ 対象    | Zenn, Qiita | 技術実験・検証レポート |
| solutions    | ❌ 対象外  | -           | ビジネス層向け課題解決 |
| case-studies | ❌ 対象外  | -           | ビジネス層向け導入事例 |

## 判定ロジック

```bash
# Cross-post対象かどうか
is_cross_post_target() {
  local category="$1"
  [[ "$category" == "tech-tips" || "$category" == "lab-reports" ]]
}
```

## 記事生成への影響

### Cross-post対象 (tech-tips, lab-reports)

**詳細版を生成** - 外部プラットフォームでコア版を作成するため、公式版は十分な深さが必要。

- Zenn/Qiitaでコア版を読んだ人が「もっと知りたい」と思える深掘り要素
- この記事からコア部分だけ抜き出しても価値があるレベルの充実度

### Cross-post対象外 (solutions, case-studies)

**ビジネス層向け** - 課題→解決→効果の流れを重視。Zenn/Qiitaには不適。
