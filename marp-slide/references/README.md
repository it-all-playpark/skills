# Marp Slide References

営業資料品質のスライドを生成するためのリファレンス集。

## Pattern Selection Guide

| Input Type | Recommended Pattern | Slide Count |
|------------|---------------------|-------------|
| 導入事例・ケーススタディ | problem-solution | 10-15 |
| 新機能・ツール紹介 | product-intro | 8-12 |
| 技術記事・ブログ | tech-talk | 10-15 |
| 学習コンテンツ | tutorial | 12-20 |
| 短時間発表（LT） | lightning-talk | 5-8 |

## Theme Selection Guide

| Use Case | Tone | Theme |
|----------|------|-------|
| 社内報告 | formal | corporate |
| クライアント提案 | formal | corporate |
| 営業資料 | formal | corporate / minimal |
| 技術LT | casual | colorful |
| 勉強会 | educational | minimal |
| チュートリアル | educational | colorful |
| OSS紹介 | casual | minimal |
| スタートアップピッチ | casual | colorful |

## File Structure

```
references/
├── README.md              # This file
├── design-guidelines.md   # 共通デザインルール
├── tones.md               # Voice tone definitions
├── structures/            # パターン別構造定義
│   ├── problem-solution.md
│   ├── product-intro.md
│   ├── tech-talk.md
│   ├── tutorial.md
│   └── lightning-talk.md
├── themes/                # CSSテーマファイル
│   ├── minimal.css
│   ├── corporate.css
│   └── colorful.css
└── snippets/              # HTMLコンポーネント
    ├── kpi-cards.html
    ├── comparison.html
    ├── flow.html
    └── testimonial.html
```

## Loading Strategy

スキル実行時の読み込み:
1. **常時**: README.md, design-guidelines.md
2. **--type指定時**: structures/{type}.md
3. **--theme指定時**: themes/{theme}.css
4. **必要時**: snippets/*.html
