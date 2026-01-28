---
name: test-coverage
description: |
  Generate and analyze test coverage reports.
  Use when: checking coverage, finding untested code, coverage thresholds.
  Accepts args: [--threshold PERCENT] [--report html|text|json]
---

# test-coverage

Generate coverage reports.

## Execution

```bash
~/.claude/skills/test-coverage/scripts/test-coverage.sh [--threshold PERCENT] [--report FORMAT]
```

## Options

| Option | Description |
|--------|-------------|
| `--threshold` | Minimum coverage % (fails if below) |
| `--report` | Output format: html, text, json |

## Output

```json
{
  "status": "passed|failed|below_threshold",
  "coverage": {"lines": 85.5, "branches": 72.3, "functions": 90.0},
  "threshold": 80,
  "threshold_met": true
}
```

## Examples

```bash
scripts/test-coverage.sh
scripts/test-coverage.sh --threshold 80
scripts/test-coverage.sh --report html
```
