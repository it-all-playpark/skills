---
name: test-integration
description: |
  Run integration tests for module interactions.
  Use when: testing API integrations, database interactions, service communication.
  Accepts args: [target] [--setup] [--teardown]
---

# test-integration

Run integration tests with optional setup/teardown.

## Execution

```bash
~/.claude/skills/test-integration/scripts/test-integration.sh [target] [--setup] [--teardown]
```

## Options

| Option | Description |
|--------|-------------|
| `target` | Test path (auto-detects tests/integration/) |
| `--setup` | Run setup before tests |
| `--teardown` | Cleanup after tests |

## Output

```json
{
  "status": "passed|failed",
  "type": "integration",
  "target": "tests/integration",
  "setup_ran": true,
  "teardown_ran": true
}
```

## Auto-Detection Paths

Searches: `tests/integration`, `test/integration`, `__tests__/integration`

## Setup/Teardown

- `scripts/test-setup.sh` if exists
- `docker-compose.test.yml` if exists

## Examples

```bash
scripts/test-integration.sh
scripts/test-integration.sh --setup --teardown
scripts/test-integration.sh tests/api/
```
