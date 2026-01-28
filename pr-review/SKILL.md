---
name: pr-review
description: |
  Comprehensive PR review with deep analysis and auto-submit.
  Accepts args: <pr-number-or-url> [--depth quick|standard|deep]
argument-hint: [pr-number] [--depth]
context: fork
agent: Plan
allowed-tools:
  - Bash(~/.claude/skills/*)
  - Bash(gh:*)
  - Bash(npm:*)
  - Read
  - Grep
  - Glob
  - mcp__sequential-thinking__sequentialthinking
---

# PR Review: $ARGUMENTS

## Context

!`~/.claude/skills/pr-review/scripts/collect-context.sh $ARGUMENTS`

## Task

### Step 1: Deep Analysis (Required)

Use `mcp__sequential-thinking__sequentialthinking` to systematically analyze:
- Security implications of each file change
- Architectural impact and SOLID violations
- Edge cases, error handling, data validation
- Test coverage gaps

### Step 2: Generate Review

Using [review-sections.md](references/review-sections.md) checklist, determine:
- **Decision**: `approve` (LGTM) or `request-changes` (issues found)
- **Review body**: Markdown formatted review

### Step 3: Submit Directly

**Important**: Use a single Bash call with fallback to prevent duplicate submissions.

```bash
# Single command with fallback (DO NOT run separate commands)
gh pr review <pr-number> --approve --body "$(cat <<'EOF'
<review-content>
EOF
)" 2>&1 || gh pr review <pr-number> --comment --body "$(cat <<'EOF'
<review-content>
EOF
)"
```

⚠️ **Do NOT execute additional review commands after the fallback succeeds.**

Options:
- `--approve` for LGTM (auto-falls back to `--comment` for own PRs)
- `--request-changes` for issues found

Report PR URL when complete.
