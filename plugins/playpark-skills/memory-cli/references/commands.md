# memvid CLI Command Reference

## 1. save — メモリに保存

```bash
memvid put <FILE.mv2> --input <PATH> --embedding --tag type=<TYPE> --tag project=<PROJECT>
memvid commit <FILE.mv2>
```

テキストを直接保存する場合は一時ファイル経由:

```bash
TMPFILE=$(mktemp /tmp/memory-XXXXXX.md)
cat > "$TMPFILE" << 'CONTENT'
保存したい内容をここに書く
CONTENT

memvid put ~/.claude/memory/global.mv2 --input "$TMPFILE" \
  --embedding \
  --title "タイトル" \
  --tag type=feedback \
  --tag project=shift-bud \
  --uri "feedback/2026-03-16/no-mock-db"

memvid commit ~/.claude/memory/global.mv2
rip "$TMPFILE"
```

**⚠️ `commit` は必須:** 未commitフレームはWAL（Write-Ahead Log）にしか存在しない。`commit` を呼ばないとデータロスのリスクがある。`put` の後は必ず `commit` すること。

**必須フラグ:**
- `--embedding`: セマンティック検索を有効にするため常に付ける
- `--title`: 内容を端的に表すタイトル

**推奨タグ:**
- `type`: `user` | `feedback` | `project` | `reference` | `session` | `retrospective`
- `project`: 自動付与（Auto Tag Resolution参照）

**URI規約:**
```
<type>/<date>/<slug>
例: feedback/2026-03-16/no-mock-db
    project/2026-03-16/auth-middleware-rewrite
    session/2026-03-16/shift-bud-summary
```

## 2. search — メモリを検索

```bash
memvid find <FILE.mv2> --query "検索クエリ" --mode sem --top-k 5 --json
```

**検索モード:**

| モード | 用途 |
|--------|------|
| `sem` | **推奨（デフォルト）**: セマンティック検索。日本語でも英語でも意味ベースで検索可能 |
| `auto` | ハイブリッド: BM25 + セマンティック + リランク |
| `lex` | キーワード完全一致（英語のみ有効。日本語はTantivyのトークナイザー制約でヒットしない場合がある） |

**重要:** 日本語コンテンツの検索は `--mode sem` を使うこと。

**複数ファイル検索:**

```bash
# プロジェクトメモリ
memvid find .claude/memory/project.mv2 --query "クエリ" --mode sem --top-k 5 --json 2>/dev/null

# グローバルメモリ
memvid find ~/.claude/memory/global.mv2 --query "クエリ" --mode sem --top-k 5 --json
```

両方の結果をマージしてユーザーに提示する。

## 3. recall — 特定のメモリを読む

```bash
memvid view <FILE.mv2> --frame-id <FRAME_ID> --json
```

`search` の結果から `frame_id` を取得して詳細を読む。

## 4. list — 最近のメモリ一覧

```bash
memvid timeline <FILE.mv2> --limit 20 --json
```

期間指定:
```bash
memvid timeline <FILE.mv2> --since "2026-03-01" --until "2026-03-16" --json
```

## 5. stats — メモリ統計

```bash
memvid stats <FILE.mv2> --json
```

## 6. entities — エンティティ・事実の確認

```bash
memvid memories <FILE.mv2> --json
memvid facts <FILE.mv2> --entity "shift-bud"
memvid state <FILE.mv2> --entity "shift-bud"
```

## 7. init — プロジェクトメモリの初期化

```bash
memvid create <PROJECT>/.claude/memory/project.mv2
```

**⚠️ `create` は既存ファイルを上書きする。** 既存の `.mv2` ファイルに対して実行すると全データが消失する。新規作成時のみ使用すること。既存ファイルへの追記は `put` を使う。

## 8. correct — 訂正の保存（検索優先度ブースト付き）

```bash
memvid correct <FILE.mv2> --input <PATH> --embedding --title "訂正: ..."
```

`correct` は通常の `put` より検索時に優先表示される。過去のメモリが間違っていた場合に使う。

## 9. enrich — エンティティ自動抽出

```bash
memvid enrich <FILE.mv2> --engine rules
```

保存済みフレームからエンティティ（人名、プロジェクト名、技術スタック等）を自動抽出する。
抽出後は `state` / `facts` / `memories` コマンドで O(1) ルックアップが可能になる。

定期的に実行することで、`memvid state <FILE> --entity "project-name"` のような高速クエリが使えるようになる。

## 10. ask — LLM連携Q&A

```bash
export OPENAI_API_KEY=sk-...
memvid ask <FILE.mv2> --question "このプロジェクトの認証方式は？" --use-model openai --top-k 5
```

メモリを検索した上でLLMが回答を生成する。複数フレームの情報を統合した回答が得られる。

**注意:** OpenAI APIキーが必要。`--use-model` で使用モデルを指定。

## Notes

- `--embedding` フラグを忘れるとセマンティック検索ができない（BM25のみになる）
- 日本語コンテンツは `--embedding` でベクトル化すれば検索可能（BGE-smallは多言語対応）
- `.mv2` ファイルはバイナリだがポータブル。git LFS で管理可能
- Free tierは50MB制限。通常のテキストメモリなら数千件は余裕
- `--json` フラグで機械処理可能な出力を得る
- 一時ファイルの削除には必ず `rip` を使う（`rm` 禁止）
- `put` 後は必ず `commit` を実行する（未commitデータはWALのみに存在しロスリスクあり）
- `create` は既存ファイルを上書きするため、新規作成時のみ使用すること
