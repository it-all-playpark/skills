---
name: test-watch
description: |
  Run tests in watch mode for continuous feedback.
  Use when: developing with TDD, continuous testing during development.
  Accepts args: [target] [--filter PATTERN]
---

# test-watch

Run tests in watch mode.

## Execution

```bash
~/.claude/skills/test-watch/scripts/test-watch.sh [target] [--filter PATTERN]
```

## Options

| Option | Description |
|--------|-------------|
| `target` | Files to watch |
| `--filter` | Test pattern filter |

## Output

Initial JSON then starts interactive watch:
```json
{
  "status": "starting",
  "framework": "vitest",
  "command": "npm run test -- --watch",
  "message": "Starting watch mode..."
}
```

## Framework Support

| Framework | Watch Command |
|-----------|---------------|
| Vitest | --watch |
| Jest | --watch |
| Pytest | pytest-watch (ptw) |
| Cargo | cargo watch |

## Examples

```bash
scripts/test-watch.sh
scripts/test-watch.sh src/
scripts/test-watch.sh --filter "auth"
```
