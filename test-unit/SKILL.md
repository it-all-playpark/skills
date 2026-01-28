---
name: test-unit
description: |
  Run unit tests for individual functions/components.
  Use when: running unit tests, testing isolated components.
  Accepts args: [target] [--filter PATTERN] [--verbose]
---

# test-unit

Run unit tests with auto-detected framework.

## Scripts

### detect-test.sh

Shared framework detection (used by all test-* skills).

```bash
~/.claude/skills/test-unit/scripts/detect-test.sh [directory]
```

Output:
```json
{
  "framework": "vitest|jest|pytest|cargo|go",
  "commands": {"unit": "...", "coverage": "...", "e2e": "...", "watch": "..."},
  "has_playwright": true|false,
  "has_cypress": true|false
}
```

### test-unit.sh

```bash
~/.claude/skills/test-unit/scripts/test-unit.sh [target] [--filter PATTERN] [--verbose]
```

Output:
```json
{
  "status": "passed|failed",
  "framework": "vitest",
  "tests": {"total": 42, "passed": 40, "failed": 2},
  "duration_seconds": 5
}
```

## Supported Frameworks

| Detector | Framework |
|----------|-----------|
| vitest.config.* | Vitest |
| jest.config.* | Jest |
| pytest.ini | Pytest |
| Cargo.toml | Cargo |
| go.mod | Go |

## Examples

```bash
scripts/test-unit.sh
scripts/test-unit.sh src/utils/
scripts/test-unit.sh --filter "auth" --verbose
```
