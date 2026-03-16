---
name: memory-cli
description: >-
  Cross-agent persistent memory with hybrid search (BM25 + semantic) via memvid CLI.
  Use when: (1) saving knowledge, learnings, or context for future sessions,
  (2) searching past memories across projects,
  (3) keywords like "覚えて", "記憶", "remember", "recall", "memory", "前に話した", "以前の",
  (4) session-load/session-save integration for automatic context persistence.
  Accepts args: <subcommand> [options]
---

# Memory CLI Skill

Cross-agent persistent memory powered by `memvid` CLI (Rust, single-file `.mv2` format).
Hybrid search (BM25 lexical + HNSW vector) with sub-millisecond retrieval.

## Prerequisites

- `memvid` CLI installed (`npm install -g memvid-cli`)
- Memory file initialized at `~/.claude/memory/global.mv2`

## Memory File Locations

| ファイル | 用途 |
|---------|------|
| `~/.claude/memory/global.mv2` | 全プロジェクト共通メモリ（ユーザー設定、フィードバック、汎用知識） |
| `<project>/.claude/memory/project.mv2` | プロジェクト固有メモリ（アーキテクチャ判断、バグパターン等） |

プロジェクト固有メモリが存在する場合は両方検索する。存在しない場合はグローバルのみ。

## Execution Protocol

**全コマンドで `.mv2` ファイルパスを明示的に指定する。**

### Memory File Resolution

1. プロジェクトルートに `.claude/memory/project.mv2` があるか確認
2. あれば **プロジェクトメモリを優先**、なければグローバルのみ
3. `save` 時: コンテンツの性質に応じてグローバル or プロジェクトに振り分け
   - ユーザー設定・フィードバック → グローバル
   - プロジェクト固有の判断・パターン → プロジェクト

### グローバルメモリパス

```
~/.claude/memory/global.mv2
```

## Subcommands

### 1. save — メモリに保存

```bash
memvid put <FILE.mv2> --input <PATH> --embedding --tag type=<TYPE> --tag project=<PROJECT>
```

テキストを直接保存する場合は一時ファイル経由:

```bash
# 一時ファイルに内容を書き出し
TMPFILE=$(mktemp /tmp/memory-XXXXXX.md)
cat > "$TMPFILE" << 'CONTENT'
保存したい内容をここに書く
CONTENT

# メモリに保存（embedding付き）
memvid put ~/.claude/memory/global.mv2 --input "$TMPFILE" \
  --embedding \
  --title "タイトル" \
  --tag type=feedback \
  --tag project=shift-bud \
  --uri "feedback/2026-03-16/no-mock-db"

# 一時ファイル削除
rip "$TMPFILE"
```

**必須フラグ:**
- `--embedding`: セマンティック検索を有効にするため常に付ける
- `--title`: 内容を端的に表すタイトル

**推奨タグ:**
- `type`: `user` | `feedback` | `project` | `reference` | `session` | `retrospective`
- `project`: プロジェクト名（`shift-bud`, `corporate-site` 等）

**URI規約:**
```
<type>/<date>/<slug>
例: feedback/2026-03-16/no-mock-db
    project/2026-03-16/auth-middleware-rewrite
    session/2026-03-16/shift-bud-summary
```

### 2. search — メモリを検索

```bash
memvid find <FILE.mv2> --query "検索クエリ" --mode sem --top-k 5 --json
```

**検索モード:**

| モード | 用途 |
|--------|------|
| `sem` | **推奨（デフォルト）**: セマンティック検索。日本語でも英語でも意味ベースで検索可能 |
| `auto` | ハイブリッド: BM25 + セマンティック + リランク |
| `lex` | キーワード完全一致（英語のみ有効。日本語のlexical検索はTantivyのトークナイザー制約でヒットしない場合がある） |

**重要:** 日本語コンテンツの検索は `--mode sem` を使うこと。`lex` モードはTantivyの標準トークナイザーが日本語未対応のため、日本語キーワードでヒットしない。

**複数ファイル検索:**

プロジェクトメモリとグローバルの両方を検索する場合:

```bash
# プロジェクトメモリ
memvid find .claude/memory/project.mv2 --query "クエリ" --mode sem --top-k 5 --json 2>/dev/null

# グローバルメモリ
memvid find ~/.claude/memory/global.mv2 --query "クエリ" --mode sem --top-k 5 --json
```

両方の結果をマージしてユーザーに提示する。

### 3. recall — 特定のメモリを読む

```bash
memvid view <FILE.mv2> --frame-id <FRAME_ID> --json
```

`search` の結果から `frame_id` を取得して詳細を読む。

### 4. list — 最近のメモリ一覧

```bash
memvid timeline <FILE.mv2> --limit 20 --json
```

期間指定:
```bash
memvid timeline <FILE.mv2> --since "2026-03-01" --until "2026-03-16" --json
```

### 5. stats — メモリ統計

```bash
memvid stats <FILE.mv2> --json
```

### 6. entities — エンティティ・事実の確認

```bash
memvid memories <FILE.mv2> --json
memvid facts <FILE.mv2> --entity "shift-bud"
memvid state <FILE.mv2> --entity "shift-bud"
```

### 7. init — プロジェクトメモリの初期化

```bash
memvid create <PROJECT>/.claude/memory/project.mv2
```

### 8. correct — 訂正の保存（検索優先度ブースト付き）

```bash
memvid correct <FILE.mv2> --input <PATH> --embedding --title "訂正: ..."
```

`correct` は通常の `put` より検索時に優先表示される。過去のメモリが間違っていた場合に使う。

## Workflow Patterns

### session-save 統合

セッション終了時にセッションサマリーを保存:

```bash
TMPFILE=$(mktemp /tmp/session-XXXXXX.md)
# セッションサマリーを書き出し
cat > "$TMPFILE" << 'EOF'
セッション内容...
EOF

memvid put ~/.claude/memory/global.mv2 --input "$TMPFILE" \
  --embedding \
  --title "Session: shift-bud 認証リファクタリング" \
  --tag type=session \
  --tag project=shift-bud \
  --uri "session/2026-03-16/shift-bud-auth-refactor"

rip "$TMPFILE"
```

### session-load 統合

セッション開始時に関連メモリを検索:

```bash
memvid find ~/.claude/memory/global.mv2 \
  --query "shift-bud 最近のセッション" \
  --mode auto --top-k 3 --json
```

### skill-retrospective 統合

振り返り結果の保存:

```bash
memvid put ~/.claude/memory/global.mv2 --input retrospective.md \
  --embedding \
  --title "Retrospective: dev-kickoff failures 2026-03" \
  --tag type=retrospective \
  --uri "retrospective/2026-03-16/dev-kickoff"
```

### ユーザーフィードバックの保存

```bash
# ユーザーが「テストでDBをモックしないで」と言った場合
TMPFILE=$(mktemp /tmp/memory-XXXXXX.md)
cat > "$TMPFILE" << 'EOF'
## フィードバック: テストでDBモック禁止

Integration testsでは実DBを使うこと。モックは禁止。

**理由:** 前四半期にモックテストがパスしたが本番マイグレーションが壊れた。
**適用場面:** テスト作成時、テスト方針の議論時。
EOF

memvid put ~/.claude/memory/global.mv2 --input "$TMPFILE" \
  --embedding \
  --title "Feedback: テストでDBモック禁止" \
  --tag type=feedback \
  --uri "feedback/2026-03-16/no-mock-db"

rip "$TMPFILE"
```

## Important Notes

- `--embedding` フラグを忘れるとセマンティック検索ができない（BM25のみになる）
- 日本語コンテンツは `--embedding` でベクトル化すれば検索可能（BGE-smallは多言語対応）
- `.mv2` ファイルはバイナリだがポータブル。git LFS で管理可能
- Free tierは50MB制限。通常のテキストメモリなら数千件は余裕
- `--json` フラグで機械処理可能な出力を得る
- 一時ファイルの削除には必ず `rip` を使う（`rm` 禁止）
