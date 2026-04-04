---
name: dev-plan-review
description: |
  Critically review implementation plan as independent agent (devil's advocate).
  Use when: (1) plan quality gate before implementation, (2) dev-kickoff Phase 3b,
  (3) standalone review of any impl-plan.md,
  (4) keywords: plan review, 計画レビュー, devil's advocate, 批判的レビュー
  Accepts args: [<issue-number>] [--worktree <path>] [--plan <path>] [--max-rounds 3]
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
context: fork
agent: general-purpose
---

# Plan Review

Independent critical review of implementation plans. Runs in a separate context (context:fork) to eliminate confirmation bias from the Planner (dev-plan-impl).

## Usage

### dev-kickoff 経由 (Phase 3b)

```
/dev-plan-review <issue-number> --worktree <path>
```

### スタンドアロン

```
/dev-plan-review --plan path/to/impl-plan.md
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | - | GitHub issue number (worktree mode) |
| `--worktree` | - | Worktree path (reads kickoff.json + impl-plan.md) |
| `--plan` | - | Direct path to plan file (standalone mode) |
| `--max-rounds` | `3` | Max review-revision rounds |

## Workflow

```
1. Collect inputs → 2. Review against checklist → 3. Classify findings → 4. Verdict → 5. Output JSON
```

## Step 1: Collect Inputs

**Worktree mode** (from dev-kickoff):
1. **Issue requirements**: Read `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`
2. **Implementation plan**: Read `$WORKTREE/.claude/impl-plan.md`
3. **Config**: Read `$WORKTREE/.claude/kickoff.json` → `config`

**Standalone mode** (direct invocation):
1. Read the plan file specified by `--plan`
2. If the plan references an issue, try to read issue context from git or GitHub

If impl-plan.md does not exist (worktree mode) or plan file does not exist (standalone mode), output error JSON and exit.

## Step 2: Review Against Checklist

Apply [Review Checklist](references/review-checklist.md) systematically.

For each dimension, evaluate whether the plan adequately addresses the concern. Be specific — cite the exact section of the plan that is problematic or missing.

## Step 3: Classify Findings

For each finding:
- **blocking**: Must be fixed before implementation. The plan has a gap that will cause rework.
- **non-blocking**: Worth noting but implementation can proceed. Minor improvements.

A finding is blocking if ANY of:
- Missing or untestable acceptance criteria
- Architecture decision without rationale that could lead to wrong direction
- File changes that will conflict or are missing critical files
- Edge cases listed without handling strategy
- Dependencies not accounted for
- Security implications ignored
- Implementation order has dependency contradictions

## Step 4: Determine Verdict

- No blocking findings → verdict: **pass**
- Blocking findings exist → verdict: **fail**
  - Include specific, actionable feedback for each blocking finding
  - Each feedback item should describe: what's wrong, why it matters, suggested fix

## Step 5: Output JSON

Print the review result as JSON to stdout. This is the return value to the caller (dev-kickoff or user).

### Pass:

```json
{
  "verdict": "pass",
  "findings": [
    {"dimension": "scope", "severity": "non-blocking", "description": "..."}
  ],
  "summary": "Plan is solid. Minor suggestions noted."
}
```

### Fail:

```json
{
  "verdict": "fail",
  "findings": [
    {"dimension": "architecture", "severity": "blocking", "description": "...", "suggestion": "..."},
    {"dimension": "edge_cases", "severity": "non-blocking", "description": "..."}
  ],
  "summary": "2 blocking issues found. Plan needs revision before implementation."
}
```

## Important

- **No access to planning context**: You only see the plan and requirements. This is by design.
- **Be specific in feedback**: "Architecture is weak" is useless. Point to specific decisions, missing files, or gaps.
- **Review honestly**: The purpose is to catch plan-level issues before wasting implementation effort, not to rubber-stamp.
- **Respect scope**: Don't demand features beyond the issue requirements. YAGNI applies to review too.
- **Standalone is lightweight**: In standalone mode without issue context, focus on internal consistency and completeness of the plan itself.

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On pass or fail verdict (review completed successfully)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-review success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On review process error (missing inputs, script crash, etc.)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-review failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

Note: A "fail" verdict is a successful review — the reviewer did its job. Only log as failure when the review process itself errors.

## References

- [Review Checklist](references/review-checklist.md) - Review dimensions and criteria
