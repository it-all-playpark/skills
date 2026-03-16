# Memory CLI Workflow Patterns

## session-save 統合

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

rip "$TMPFILE"
```

## session-load 統合

セッション開始時に関連メモリを検索:

```bash
memvid find ~/.claude/memory/global.mv2 \
  --query "shift-bud 最近のセッション" \
  --mode auto --top-k 3 --json
```

## skill-retrospective 統合

振り返り結果の保存:

```bash
memvid put ~/.claude/memory/global.mv2 --input retrospective.md \
  --embedding \
  --title "Retrospective: dev-kickoff failures 2026-03" \
  --tag type=retrospective \
  --uri "retrospective/2026-03-16/dev-kickoff"
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

rip "$TMPFILE"
```
