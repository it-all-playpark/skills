---
name: pr-review
description: |
  Comprehensive PR review with deep analysis and auto-submit.
  Accepts args: <pr-number-or-url> [--depth quick|standard|deep]
argument-hint: [pr-number] [--depth]
model: opus
effort: max
context: fork
allowed-tools:
  - Bash(~/.claude/skills/*)
  - Bash(gh:*)
  - Bash(npm:*)
  - Read
  - Grep
  - Glob
---

# PR Review: $ARGUMENTS

## 言語ルール

**レビューコメントは必ず日本語で記述すること。**
- レビュー本文（body）、指摘事項、改善提案はすべて日本語
- コード識別子・ファイルパス・技術用語はそのまま
- `review-sections.md` のOutput Formatに従い日本語で出力

## Context

!`~/.claude/skills/pr-review/scripts/collect-context.sh $ARGUMENTS`

## Task

### Step 1: Tech Stack Detection & Best Practice Loading

1. Run `$SKILLS_DIR/_lib/scripts/detect-stack.sh` on the PR's repository root to detect frameworks
2. For each detected skill in `rules_paths`, Read the corresponding SKILL.md to load framework-specific rules
3. Combine with [analysis-domains.md](~/.claude/skills/_lib/analysis-domains.md) domain criteria for comprehensive review

### Step 2: Generate Review

Using [review-sections.md](references/review-sections.md) checklist, determine:
- **Decision**: `approve` (LGTM) or `request-changes` (issues found)
- **Review body**: Markdown formatted review

Analyze systematically:
- Security implications of each file change
- Architectural impact and SOLID violations
- Edge cases, error handling, data validation
- Test coverage gaps
- **Best practice violations** — if frameworks were detected in Step 1, check changes against the loaded best-practice rules and include a dedicated section for framework-specific findings

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

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (review submitted)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-review success \
  --issue $ISSUE --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-review failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

