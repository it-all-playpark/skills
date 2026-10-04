# Memory CLI Workflow Patterns

## セッション保存パターン

セッション終了時にセッションサマリーを保存:

```bash
TMPFILE=$(mktemp /tmp/session-XXXXXX.md)
cat > "$TMPFILE" << 'EOF'
セッション内容...
EOF

memvid put ~/.claude/memory/global.mv2 --input "$TMPFILE" \
  --embedding \
  --title "Session: shift-bud 認証リファクタリング" \
  --tag type=session \
  --tag project=shift-bud \
  --uri "session/2026-03-16/shift-bud-auth-refactor"

memvid commit ~/.claude/memory/global.mv2
rip "$TMPFILE"
```

## セッション読み込みパターン

セッション開始時に関連メモリを検索:

```bash
memvid find ~/.claude/memory/global.mv2 \
  --query "shift-bud 最近のセッション" \
  --mode auto --top-k 3 --json
```

## ユーザーフィードバックの保存

```bash
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

memvid commit ~/.claude/memory/global.mv2
rip "$TMPFILE"
```
