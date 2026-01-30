# Tech-Talk Pattern (10-15 slides)

技術発表・勉強会向け。

## Structure

```
1. Cover (cover)
   - タイトル、発表者名

2. Agenda (agenda)
   - 3-5項目の目次

3. Background/Context
   - なぜこの話をするのか
   - 前提知識・状況説明

4-5. Problem Statement
   - 解決したい課題
   - 具体的な困りごと

6-8. Solution/Approach (two-col, flow)
   - 採用したアプローチ
   - 技術的な詳細
   - コード例

9-10. Results/Demo (kpi-cards)
   - 実装結果
   - デモ・スクリーンショット

11-12. Lessons Learned
   - 得られた知見
   - 注意点・Tips

13. Summary (lead)
   - 要点まとめ（3点以内）

14. Next Steps
   - 今後の展望
   - 聴衆へのアクション

15. Q&A / Closing (closing)
    - 連絡先・リンク
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

# Fastifyで作る高速API

Node.js Webフレームワーク比較と実践

@username

---

<!-- _class: agenda -->

## アジェンダ

- Fastifyとは
- Express vs Fastify
- 実装パターン
- パフォーマンス検証

---

## 背景

### なぜFastifyを選んだか

- Expressのパフォーマンス限界
- TypeScript対応の必要性
- スキーマバリデーション需要

---

## 課題

### Express運用での問題点

1. **レスポンス遅延** - P99が500ms超
2. **型安全性** - ランタイムエラー多発
3. **バリデーション** - 自前実装の負担

---

<!-- _class: comparison -->

## Express vs Fastify

<div class="before">
<h3>Express</h3>
<ul>
<li>req/sec: 15,000</li>
<li>型: 別途定義必要</li>
<li>バリデーション: 自前</li>
</ul>
</div>

<div class="arrow">→</div>

<div class="after">
<h3>Fastify</h3>
<ul>
<li>req/sec: 45,000</li>
<li>型: JSON Schema連携</li>
<li>バリデーション: 組込み</li>
</ul>
</div>

---

## 実装例

```typescript
import Fastify from 'fastify'

const fastify = Fastify({ logger: true })

fastify.get('/users/:id', {
  schema: {
    params: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  return { userId: request.params.id }
})
```

---

## ベンチマーク結果

<div class="kpi-container">
<div class="kpi-card">
<div class="number">3x</div>
<div class="label">スループット向上</div>
<div class="change">15K→45K req/sec</div>
</div>
<div class="kpi-card">
<div class="number">60%</div>
<div class="label">レイテンシ削減</div>
<div class="change">P99: 500ms→200ms</div>
</div>
<div class="kpi-card">
<div class="number">0件</div>
<div class="label">型エラー</div>
<div class="change">スキーマ検証で防止</div>
</div>
</div>

---

## 学んだこと

### Tips & 注意点

1. **プラグイン設計** - デコレータで拡張
2. **エラーハンドリング** - setErrorHandler活用
3. **移行戦略** - 段階的に置き換え

---

<!-- _class: lead -->

# まとめ

Fastifyは高速・型安全・開発体験が優れたフレームワーク

---

<!-- _class: closing -->

# ありがとうございました

**スライド・コード**
https://github.com/username/fastify-talk

@username
```
