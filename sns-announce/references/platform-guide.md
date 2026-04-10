# SNS Platform Guide

## Platform Overview

| Platform | Limit | Audience | Style |
|----------|-------|----------|-------|
| X | 280 (JA ~120字) | 幅広い層 | Hook + URL + hashtags (2-3) |
| LinkedIn | 1,300 | ビジネス・経営層 | Professional, bullets, hashtags (4-6) |
| Google | 1,500 | ローカル検索ユーザー | No hashtags, CTA, local focus |
| Facebook | 500推奨 | 幅広い層・やや高年齢 | カジュアル、絵文字OK、シェア促進 |
| Bluesky | 300 | テック系早期採用者 | X風だがよりカジュアル、ハッシュタグ控えめ |
| Threads | 500 | 若年層・Instagram連携 | カジュアル、絵文字多め、会話的 |

## Character Limits Detail

### X (Twitter)
- **英語**: 280文字
- **日本語**: 実質140文字（CJK文字は2カウント）
- **URL**: 常に23文字としてカウント（自動短縮）
- **目安**: 本文100字 + URL + ハッシュタグ2-3個

### LinkedIn
- **上限**: 1,300文字（言語問わず）
- **推奨**: 600-800文字程度が読まれやすい

### Google Business
- **上限**: 1,500文字
- **ハッシュタグ**: 非対応

### Facebook
- **上限**: 63,206文字
- **推奨**: 500文字以下が読まれやすい
- **特徴**: 絵文字、シェア促進文が効果的

### Bluesky
- **上限**: 300文字
- **特徴**: ATプロトコル、ハッシュタグは控えめに

### Threads
- **上限**: 500文字
- **特徴**: Instagram連携ユーザー向け、カジュアルな会話調

---

## URL Generation

When UTM is enabled in config, replace `{url}` with platform-specific UTM URL:
```
{base_url}/blog/{slug}?utm_source={utm.source_map[platform]}&utm_medium={utm.medium}&utm_campaign={slug}
```

Example for slug `my-article`:
- X: `https://www.playpark.co.jp/blog/my-article?utm_source=x&utm_medium=social&utm_campaign=my-article`
- LinkedIn: `https://www.playpark.co.jp/blog/my-article?utm_source=linkedin&utm_medium=social&utm_campaign=my-article`
- Google: `https://www.playpark.co.jp/blog/my-article?utm_source=google_business&utm_medium=social&utm_campaign=my-article`
- Facebook: `https://www.playpark.co.jp/blog/my-article?utm_source=facebook&utm_medium=social&utm_campaign=my-article`
- Bluesky: `https://www.playpark.co.jp/blog/my-article?utm_source=bluesky&utm_medium=social&utm_campaign=my-article`
- Threads: `https://www.playpark.co.jp/blog/my-article?utm_source=threads&utm_medium=social&utm_campaign=my-article`

---

## Japanese Templates

### X - 日本語 (~120字)
```
【{emoji} {短いタイトル}】

{フック文（問題提起 or 価値提案）}

▶ {url}?utm_source=x&utm_medium=social&utm_campaign={slug}

#{tag1} #{tag2} #{tag3}
```

**カテゴリ絵文字**:
- 🔧 tech-tips
- 📊 case-studies  
- 💡 solutions
- 🧪 lab-reports

### LinkedIn - 日本語
```
{フック段落}

{課題や背景の説明}

📌 ポイント
• {要点1}
• {要点2}
• {要点3}

{CTA文}

🔗 {url}?utm_source=linkedin&utm_medium=social&utm_campaign={slug}

#{tag1} #{tag2} #{tag3} #{tag4}
```

### Google Business - 日本語
```
{タイトル}

{説明文}

{特徴や価値}

詳しくはこちらをご覧ください。
{url}?utm_source=google_business&utm_medium=social&utm_campaign={slug}
```

---

## English Templates

### X - English (~250 chars)
```
{emoji} {Short title}

{Hook sentence with value proposition}

👉 {url}?utm_source=x&utm_medium=social&utm_campaign={slug}

#{tag1} #{tag2} #{tag3}
```

### LinkedIn - English
```
{Hook paragraph}

{Problem/context}

📌 Key Takeaways:
• {point1}
• {point2}
• {point3}

{CTA}

🔗 {url}?utm_source=linkedin&utm_medium=social&utm_campaign={slug}

#{tag1} #{tag2} #{tag3} #{tag4}
```

---

## Content Analysis Points

1. **Opening** → フック素材
2. **Headings** → 箇条書きポイント
3. **Numbers/Metrics** → 注目ポイント
4. **Conclusion** → 価値提案
