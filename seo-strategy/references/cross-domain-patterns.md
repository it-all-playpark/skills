# Cross-Domain Communication Patterns

専門家間の SendMessage テンプレート。分析中に他の専門家の知見が必要な場合に使用する。

## When to Communicate

クロスドメイン問い合わせは以下の場合にのみ発行する:
- 自分の担当セクションの判断に他専門家のデータが**必要**な場合
- 矛盾する可能性のある提案を検出した場合
- 他専門家の出力に直接影響する発見をした場合

**不要な場合は問い合わせない**。各専門家は自分の担当領域を独立して分析できることが前提。

## Pattern Templates

### Content Strategist → Tech SEO Specialist

**内部リンク候補の技術的妥当性確認**:
```
記事 [slug] を [target-slug] への内部リンク元として提案しています。
codebase_audit の internal_links データで、[target-slug] の現在のリンク構造を確認できますか？
孤立記事（orphan）であれば優先度を上げたいです。
```

**構造化データの対応確認**:
```
新規記事方向性として [keyword_area] を提案しています。
現在の JSON-LD 設定で、このカテゴリの記事に適切な構造化データが適用されますか？
追加の schema type が必要であれば、technical_seo の提案に含めてください。
```

### Content Strategist → Channel KPI Analyst

**チャネル×コンテンツの相関確認**:
```
記事 [slug] のリライトを high priority で提案しています（low_ctr_high_imp）。
この記事の流入チャネル分布を確認できますか？
特定チャネルからの流入が dominant であれば、チャネル戦略と連動した改善にしたいです。
```

**ファネル位置の妥当性確認**:
```
新規記事方向性 [keyword_area] を「認知」ファネルで提案しています。
domain_authority_map でこの領域の strength はどうですか？
weak であれば「検討」ファネル（ロングテール）に変更を検討します。
```

### Tech SEO Specialist → Content Strategist

**モバイル離脱が高い記事のコンテンツ確認**:
```
device_gap_analysis で [slug] のモバイル離脱率が異常に高いです（gap: [X]pt）。
この記事のコンテンツに、モバイルで見づらい要素（大きなテーブル、長いコードブロック等）はありますか？
技術的修正とコンテンツ修正の両面で対応したいです。
```

**orphan 記事のコンテンツ価値確認**:
```
codebase_audit で [slug] が orphan article として検出されました。
article_metrics でこの記事の impressions/clicks はどうですか？
価値があれば内部リンク追加、なければ site_structure の優先度を下げます。
```

### Tech SEO Specialist → Channel KPI Analyst

**技術課題のチャネル影響確認**:
```
codebase_audit で [issue_type] を検出しました（severity: [level]）。
この技術課題が特定チャネルの bounce_rate に影響している可能性はありますか？
チャネル別の bounce_rate データと照合したいです。
```

### Channel KPI Analyst → Content Strategist

**高離脱チャネルのコンテンツ確認**:
```
[channel] チャネルの bounce_rate が [X]% で異常に高いです。
このチャネルから流入している主要記事はどれですか？
記事の期待とコンテンツの不一致（intent mismatch）が原因の可能性があります。
```

**カテゴリ権威性低下の原因調査**:
```
category_performance で [category] の zero_impression_rate が [X]% です。
このカテゴリの記事で、KW 選定に問題がある記事はどれですか？
記事改善 vs 新規記事 のどちらが効果的か判断したいです。
```

### Channel KPI Analyst → Tech SEO Specialist

**チャネル固有の技術問題確認**:
```
[channel] からの流入で bounce_rate が高いですが、コンテンツ問題ではない可能性もあります。
OGP/Twitter Card/構造化データの設定で、[channel] 向けに改善できる点はありますか？
channel_strategy の actions に技術的改善を含めたいです。
```

## Communication Protocol

1. **SendMessage で質問を送信** → 相手の名前を `to` に指定
2. **受信側は次のターンで回答** → 自分の分析を中断せず、可能な範囲で回答
3. **回答不可の場合**: 「データ不足のため回答できません」と返答 → 質問側は自力で判断
4. **1問い合わせにつき1回答**: 追加質問は別の SendMessage で送信
5. **最大問い合わせ数**: 各専門家あたり 3 回まで（ターン予算を消費しすぎないため）
