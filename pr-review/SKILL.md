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

### Step 3: Submit Review

1. Write review body to a temporary file
2. Call submit script with decision

```bash
# Write review to temp file
cat > /tmp/pr-review-body.md <<'EOF'
<review-content>
EOF

# Submit review (handles own-PR fallback automatically)
$SKILLS_DIR/pr-review/scripts/submit-review.sh <pr-number> <decision> /tmp/pr-review-body.md
```

**Decision options**:
- `approve` - LGTM (auto-falls back to comment for own PRs)
- `request-changes` - Issues found
- `comment` - Neutral feedback

Report PR URL when complete.
