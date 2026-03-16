---
name: session-save
description: |
  Session lifecycle management - save context and learnings.
  Use when: (1) ending session, (2) creating checkpoint, (3) preserving context,
  (4) keywords: save, checkpoint, preserve, end session, persist
  Accepts args: [--type session|learnings|checkpoint] [--summarize]
---

# session-save

Save session context and learnings.

## Usage

```
/session-save [--type session|learnings|checkpoint] [--summarize]
```

| Arg | Description |
|-----|-------------|
| --type | What to save |
| --summarize | Generate summary |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/save-session.sh --title "TITLE" --content "CONTENT" [--target global\|project] [--type session\|project\|feedback] [--tags "k=v,..."]` | Save content to memvid with auto-tagging |
| `scripts/check-failures.sh` | Check for unanalyzed journal failures (returns `{"failure_count": N}`) |

## Workflow

1. **Check failures** → Run `scripts/check-failures.sh`; notify if count > 0
2. **Gather** → Collect session state (tasks, decisions, learnings)
3. **Compose** → Build title and content for memvid entry
4. **Save** → Run `scripts/save-session.sh` with appropriate `--target` and `--type`
5. **Verify** → Parse JSON result for success
6. **Report** → Show what was saved

## Save Types

| Type | Content | Target |
|------|---------|--------|
| session | Full session state | global |
| learnings | Key insights only | global or project |
| checkpoint | Recovery point | project |

## Failure Check

| Result | Action |
|--------|--------|
| 0 entries | Skip (no failures to analyze) |
| 1+ entries | Notify: "N件の新規失敗エントリあり。`/skill-retrospective` で分析できます" |

## Output

```markdown
## Save: [type]

### Saved
- Session ID: [id]
- Duration: [time]
- Tasks completed: [count]

### Summary (if --summarize)
[Brief session summary]

### Recovery
To resume: `/session-load --type checkpoint`
```

## Examples

```bash
/session-save
/session-save --type checkpoint
/session-save --type learnings --summarize
```

## Integration

Pairs with `/session-load` for session lifecycle.
