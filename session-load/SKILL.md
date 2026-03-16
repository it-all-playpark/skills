---
name: session-load
description: |
  Session lifecycle management - load project context and memories.
  Use when: (1) starting session, (2) resuming work, (3) loading context,
  (4) keywords: load, resume, start session, context, continue
  Accepts args: [--type project|checkpoint] [--refresh] [--analyze]
---

# session-load

Load project context and session state.

## Usage

```
/session-load [--type project|checkpoint] [--refresh] [--analyze]
```

| Arg | Description |
|-----|-------------|
| --type | What to load |
| --refresh | Force reload even if cached |
| --analyze | Deep analysis after load |

## Load Types

| Type | Action |
|------|--------|
| project | Load project context, CLAUDE.md |
| checkpoint | Resume from saved checkpoint |

## Workflow

1. **Initialize** → Establish session
2. **Sync External Skills** → Run `$SKILLS_DIR/_lib/infra/link-agent-skills.sh` to sync `.agents/skills/` symlinks
3. **Discover** → Find project context files
4. **Load** → Read CLAUDE.md, memories
5. **Recall memvid** → Search memvid for related session/project memories
6. **Activate** → Set up working context
7. **Report** → Show loaded state

## What Gets Loaded

- Project CLAUDE.md
- Previous session memories (from memvid via `memory-cli`)
- Checkpoints (if any)
- Environment context

## memvid Integration

セッション開始時に memvid から関連メモリを検索してコンテキストを復元する。

```bash
# プロジェクトメモリがあれば両方検索
if [ -f .claude/memory/project.mv2 ]; then
  memvid find .claude/memory/project.mv2 \
    --query "<PROJECT_NAME> 最近のセッション" \
    --mode sem --top-k 3 --json 2>/dev/null
fi

# グローバルメモリ
memvid find ~/.claude/memory/global.mv2 \
  --query "<PROJECT_NAME> 最近のセッション" \
  --mode sem --top-k 3 --json
```

検索結果がある場合、セッションコンテキストに含めて報告する。

## Output

```markdown
## 📂 Load: Session Initialized

### Project
- Name: [project name]
- Type: [detected type]

### Context Loaded
- [ ] CLAUDE.md
- [ ] Previous memories
- [ ] Checkpoints

### Ready
[Summary of session state]
```

## Examples

```bash
/session-load
/session-load --type checkpoint
/session-load --refresh --analyze
```

## Integration

Pairs with `/session-save` for session lifecycle.
