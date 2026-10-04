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

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/load-context.sh [--refresh]` | Gather deterministic context: sync skills, detect project, search memvid |

### Output (JSON)

```json
{
  "project": "<name>",
  "memories": {"project": [...], "global": [...]},
  "synced_skills": true
}
```

## Workflow

1. **Run script** → `scripts/load-context.sh` to gather context
2. **Read** → Parse JSON result for project name and memories
3. **Discover** → Find and read project CLAUDE.md
4. **Activate** → Set up working context from memories
5. **Report** → Show loaded state to user

## What Gets Loaded

- Project CLAUDE.md
- Previous session memories (from memvid via `memory-cli`)
- Checkpoints (if any)
- Environment context

## Output

```markdown
## Load: Session Initialized

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
