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
/sc:save [--type session|learnings|checkpoint] [--summarize]
```

| Arg | Description |
|-----|-------------|
| --type | What to save |
| --summarize | Generate summary |

## Save Types

| Type | Content |
|------|---------|
| session | Full session state |
| learnings | Key insights only |
| checkpoint | Recovery point |

## Workflow

1. **Gather** → Collect session state
2. **Summarize** → Extract key information
3. **Persist** → Save to memory/file
4. **Verify** → Confirm save success
5. **Report** → Show what was saved

## What Gets Saved

- Task progress
- Decisions made
- Code changes summary
- Learnings and insights

## Output

```markdown
## 💾 Save: [type]

### Saved
- Session ID: [id]
- Duration: [time]
- Tasks completed: [count]

### Summary (if --summarize)
[Brief session summary]

### Recovery
To resume: `/sc:load --type checkpoint`
```

## Examples

```bash
/sc:save
/sc:save --type checkpoint
/sc:save --type learnings --summarize
```

## Integration

Pairs with `/sc:load` for session lifecycle.
