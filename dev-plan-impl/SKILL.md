---
name: dev-plan-impl
description: |
  Create implementation plan from issue analysis (Opus planner).
  Use when: (1) dev-kickoff Phase 3, (2) implementation planning before coding,
  (3) keywords: 実装計画, implementation plan, design plan
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
effort: high
---

# Plan Implementation

Create a concrete implementation plan that the Generator (dev-implement) will follow.

## Usage

```
/dev-plan-impl <issue-number> --worktree <path>
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--worktree` | required | Worktree path for implementation |

## Workflow

```
1. Read inputs → 2. Check feedback → 3. Analyze codebase → 4. Create plan → 5. Write plan
```

## Step 1: Read Inputs

1. **Issue requirements**: Read `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`
2. **Config**: Read `$WORKTREE/.claude/kickoff.json` → `config` (testing strategy, design approach)

## Step 2: Check for Feedback (Retry)

### Evaluator Feedback (Phase 6)

If `$WORKTREE/.claude/kickoff.json` → `phases.6_evaluate.iterations[]` has entries:
- Read the latest iteration's `feedback` array
- These are specific issues the Evaluator found with the previous implementation
- The feedback_level should be `"design"` (otherwise dev-implement handles it directly)
- Address each feedback item in the new plan's Architecture Decisions and Notes for Retry sections

### Plan Review Feedback (Phase 3b)

If `$WORKTREE/.claude/plan-review-feedback.json` exists:
- Read the review findings with severity `blocking`
- Address each blocking finding in the revised plan
- Note how each finding was addressed in the Architecture Decisions or relevant section

If neither feedback source exists (first run), skip this step.

## Step 3: Analyze Codebase

1. Understand the existing code structure in the worktree
2. Identify files that need to be created or modified
3. Check for existing patterns, conventions, and dependencies
4. Consider the testing strategy (from config.testing)

## Step 4: Create Implementation Plan

Following [Plan Format](references/plan-format.md):
- Be specific about file paths and changes
- Include architecture decisions with rationale
- List edge cases with handling strategies
- Note dependencies

## Step 5: Write Plan File

Write the plan to `$WORKTREE/.claude/impl-plan.md`.

If a previous plan exists (retry), overwrite it entirely with the revised plan.

## Important

- **Be concrete, not abstract**: The Generator (Sonnet) needs specific instructions it can follow
- **Consider the testing strategy**: If config.testing is "tdd", include test files in File Changes
- **Address all feedback**: On retry, every feedback item from the Evaluator must be addressed
- **Don't over-plan**: Keep the plan focused on what's needed for the issue. YAGNI.

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (impl-plan.md written)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-impl success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-impl failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

## References

- [Plan Format](references/plan-format.md) - Output format specification
