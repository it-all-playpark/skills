# Product-Intro Pattern (8-12 slides)

プロダクト・サービス紹介向け。

## Structure

```
1. Cover (cover)
   - プロダクト名 + キャッチコピー

2. What is X?
   - 一言で説明
   - カテゴリ・ポジショニング

3. Key Features (flow or kpi-cards)
   - 3-5個の特徴
   - アイコン/図で視覚的に

4-6. Feature Deep Dive (two-col)
   - 主要機能の詳細
   - スクリーンショット/デモ

7. Use Cases
   - 具体的な活用シーン
   - ターゲットユーザー

8. Getting Started
   - 始め方（3ステップ以内）

9. Comparison (comparison)
   - 類似ツールとの違い（optional）

10. Pricing / Availability

11. Try It Now (closing)
    - CTA
    - リンク・QRコード
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

# ProductName

チームの生産性を**3倍**にする
タスク管理ツール

---

## ProductNameとは？

**チーム向けタスク管理SaaS**

- リアルタイム同期
- Slack/GitHub連携
- AI自動タグ付け

---

## 主な特徴

<div class="flow-container">
<div class="flow-step">
<div class="number">1</div>
<div class="title">シンプル</div>
<div class="desc">直感的なUI</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">2</div>
<div class="title">高速</div>
<div class="desc">リアルタイム同期</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">3</div>
<div class="title">連携</div>
<div class="desc">外部サービス統合</div>
</div>
</div>

---

<!-- _class: two-col -->

## Slack連携

<div>

### ワンクリックでタスク化

- メッセージからタスク作成
- 通知をSlackで受信
- ステータス自動更新

</div>

<div>

![Slack Integration](./screenshot-slack.png)

</div>

---

## 始め方

<div class="flow-container">
<div class="flow-step">
<div class="number">1</div>
<div class="title">サインアップ</div>
<div class="desc">30秒で完了</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">2</div>
<div class="title">チーム招待</div>
<div class="desc">メール or リンク</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">3</div>
<div class="title">利用開始</div>
<div class="desc">すぐに使える</div>
</div>
</div>

---

## 料金プラン

| プラン | 価格 | 特徴 |
|--------|------|------|
| Free | ¥0 | 5人まで |
| Team | ¥980/人 | 無制限 |
| Enterprise | お問い合わせ | SSO対応 |

---

<!-- _class: closing -->

# 14日間無料トライアル

**今すぐ始める**
https://product.example.com
```
