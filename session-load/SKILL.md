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
/sc:load [--type project|checkpoint] [--refresh] [--analyze]
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
2. **Discover** → Find project context files
3. **Load** → Read CLAUDE.md, memories
4. **Activate** → Set up working context
5. **Report** → Show loaded state

## What Gets Loaded

- Project CLAUDE.md
- Previous session memories (if Serena MCP available)
- Checkpoints (if any)
- Environment context

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
/sc:load
/sc:load --type checkpoint
/sc:load --refresh --analyze
```

## Integration

Pairs with `/sc:save` for session lifecycle.
