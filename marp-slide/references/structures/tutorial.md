# Tutorial Pattern (12-20 slides)

チュートリアル・学習コンテンツ向け。

## Structure

```
1. Cover (cover)
   - 何を学べるか明示

2. Goal
   - 完了時に何ができるようになるか

3. Prerequisites
   - 前提知識
   - 必要な環境

4. Overview (flow)
   - 全体の流れを図示

5-6. Concept Introduction (two-col)
   - 基本概念の説明
   - 図解・例え話

7-12. Step-by-Step
   - 1ステップ1スライド
   - コード + 説明
   - 各ステップの目的を明記

13-14. Common Mistakes
   - よくある間違い
   - トラブルシューティング

15-16. Practice Exercise
   - 手を動かす課題
   - 期待される結果

17. Recap (lead)
   - 学んだことの復習

18. Next Steps
   - 発展的な学習リソース

19-20. Q&A / Closing (closing)
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

# Docker入門

コンテナの基本を30分でマスター

---

## ゴール

このチュートリアル完了後、あなたは...

- ✅ Dockerの基本概念を理解
- ✅ コンテナを起動・停止できる
- ✅ Dockerfileを書ける
- ✅ Docker Composeで複数コンテナ管理

---

## 前提条件

### 必要な環境

- Docker Desktop インストール済み
- ターミナル操作の基本知識
- テキストエディタ（VSCode推奨）

### 確認コマンド

```bash
docker --version
# Docker version 24.0.0 以上
```

---

## 全体の流れ

<div class="flow-container">
<div class="flow-step">
<div class="number">1</div>
<div class="title">概念理解</div>
<div class="desc">コンテナとは</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">2</div>
<div class="title">基本操作</div>
<div class="desc">run/stop/rm</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">3</div>
<div class="title">Dockerfile</div>
<div class="desc">イメージ作成</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="number">4</div>
<div class="title">Compose</div>
<div class="desc">複数管理</div>
</div>
</div>

---

<!-- _class: two-col -->

## コンテナとは

<div>

### 仮想マシンとの違い

- **軽量** - OSを共有
- **高速** - 秒で起動
- **ポータブル** - どこでも同じ

</div>

<div>

```
┌─────────────┐
│   App A     │
├─────────────┤
│  Container  │
├─────────────┤
│   Docker    │
├─────────────┤
│   Host OS   │
└─────────────┘
```

</div>

---

## Step 1: 最初のコンテナ

### Hello World

```bash
docker run hello-world
```

**このコマンドで起きること：**

1. ローカルにイメージがなければ取得
2. コンテナを作成
3. コンテナを実行
4. 出力を表示して終了

---

## Step 2: インタラクティブモード

### Ubuntuコンテナに入る

```bash
docker run -it ubuntu bash
```

**オプション説明：**
- `-i` : 標準入力を開く
- `-t` : 擬似TTYを割り当て

```bash
# コンテナ内で
root@abc123:/# cat /etc/os-release
root@abc123:/# exit
```

---

## Step 3: Dockerfile作成

### Node.jsアプリをコンテナ化

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

**ビルド & 実行：**

```bash
docker build -t my-app .
docker run -p 3000:3000 my-app
```

---

## よくある間違い

### ❌ 間違い1: COPYの順序

```dockerfile
# Bad - キャッシュが効かない
COPY . .
RUN npm install
```

```dockerfile
# Good - package.jsonだけ先にコピー
COPY package*.json ./
RUN npm install
COPY . .
```

---

## よくある間違い

### ❌ 間違い2: ポート公開忘れ

```bash
# Bad - ポートマッピングなし
docker run my-app

# Good - ホストの3000をコンテナの3000に
docker run -p 3000:3000 my-app
```

---

## 演習問題

### 自分でやってみよう

1. `hello.js` を作成
   ```javascript
   console.log('Hello from Docker!')
   ```

2. Dockerfileを書く
3. ビルドして実行

**期待される出力：**
```
Hello from Docker!
```

---

<!-- _class: lead -->

# 学んだこと

- コンテナ = 軽量な仮想環境
- docker run でコンテナ実行
- Dockerfile でイメージ定義

---

## 次のステップ

### さらに学ぶには

- 📚 Docker公式ドキュメント
- 🎥 Docker Compose入門
- 🔧 本番運用のベストプラクティス

**おすすめリソース：**
- docs.docker.com
- Play with Docker

---

<!-- _class: closing -->

# お疲れさまでした！

**質問・フィードバック**
@username
```
