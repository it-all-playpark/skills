---
name: dev-validate
description: |
  Validate implementation by running tests and checking changes.
  Use when: verifying implementation quality, running tests, checking for regressions.
  Accepts args: [--fix] [--strict] [--worktree <path>]
model: haiku
---

# Validate

Run tests and quality checks with auto-detection.

## Execution

```bash
$SKILLS_DIR/dev-validate/scripts/validate.sh [--fix] [--strict] [--worktree <path>]
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

## kickoff.json Immutability Check

`dev-kickoff` ワークフロー下で動作する場合、`kickoff.json.feature_list` の `id` / `desc` が初コミット時点から変わっていないかを warning レベルでチェックする:

```bash
$SKILLS_DIR/dev-validate/scripts/validate-kickoff.sh --worktree <path>
```

挙動:
- `feature_list` が空 / 未定義 → silent pass（後方互換）
- `kickoff.json` に git 履歴が無い → silent pass
- `id` / `desc` が変更されている → stderr に warning を出力、JSON の `status: warning` を返す（exit 0、非致命）
- `id` が削除されている → 同じく warning

このチェックは warning-only で、overall の pass/fail には影響しない。詳細: [kickoff.json Schema](../dev-kickoff/references/kickoff-schema.md)

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

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (overall: pass)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-validate success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure (overall: fail)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-validate failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```
