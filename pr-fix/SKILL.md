---
name: pr-fix
description: |
  Automated PR fix workflow - apply fixes based on review feedback.
  Use when: (1) fixing PR based on review comments, (2) addressing CI failures,
  (3) keywords: fix PR, address review, fix changes
  Accepts args: <pr-number-or-url> [--no-push]
allowed-tools:
  - Bash
  - Read
  - Edit
  - Glob
  - Grep
---

# PR Fix

## Usage

```
/pr-fix <pr> [--no-push]
```

## Workflow

1. Run: `$SKILLS_DIR/pr-fix/scripts/pr-setup.sh $PR`
2. Implement fixes based on review output
3. Run: `$SKILLS_DIR/pr-fix/scripts/pr-finish.sh [--no-push]`

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (fixes applied and pushed)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-fix success \
  --issue $ISSUE --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-fix failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```
