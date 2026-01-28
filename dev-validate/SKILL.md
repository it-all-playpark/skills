---
name: dev-validate
description: |
  Validate implementation by running tests and checking changes.
  Use when: verifying implementation quality, running tests, checking for regressions.
  Accepts args: [--fix] [--strict] [--worktree <path>]
---

# Validate

Run tests and quality checks with auto-detection.

## Execution

```bash
~/.claude/skills/dev-validate/scripts/validate.sh [--fix] [--strict] [--worktree <path>]
```

## Options

| Option | Description |
|--------|-------------|
| `--fix` | Auto-fix lint issues if supported |
| `--strict` | Fail if lint is skipped |
| `--worktree` | Path to worktree |

## Output

```json
{
  "worktree": "/path/to/project",
  "changes": {"files": 5, "insertions": 120, "deletions": 30},
  "tests": "passed|failed|skipped|no_test_script",
  "lint": "passed|failed|skipped",
  "overall": "pass|fail",
  "exit_code": 0
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All passed |
| 1 | Tests failed |
| 2 | Lint/type errors |
| 3 | No changes |

## Auto-Detection

| Project Type | Test Command | Lint Command |
|--------------|--------------|--------------|
| Node.js | npm/yarn/pnpm test | npm run lint |
| Rust | cargo test | cargo clippy |
| Go | go test ./... | golangci-lint |
| Python | pytest | ruff check |
| Makefile | make test | - |

## Examples

```bash
scripts/validate.sh
scripts/validate.sh --fix
scripts/validate.sh --strict --worktree /path/to/worktree
```
