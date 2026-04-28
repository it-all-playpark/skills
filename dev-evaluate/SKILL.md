---
name: dev-evaluate
description: |
  Evaluate implementation quality as independent agent (GAN-style Evaluator).
  Use when: (1) post-implementation quality gate, (2) dev-kickoff Phase 6,
  (3) keywords: evaluate, 評価, quality gate, レビュー
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(~/.claude/skills/dev-evaluate/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
  - Bash(git:*)
model: opus
effort: max
context: fork
---

# Evaluate

Independent quality evaluation agent. Runs in a separate context (context:fork) to eliminate self-evaluation bias from the Generator (dev-implement).

## Usage

```
/dev-evaluate <issue-number> --worktree <path>
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--worktree` | required | Worktree path to evaluate |

## Workflow

```
1. Collect inputs → 2. Detect task type → 3. Load strategy → 4. Score → 5. Verdict → 6. Output JSON
```

## Step 1: Collect Inputs

Gather evaluation context from the worktree:

1. **Issue requirements**: Read `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`
2. **Implementation plan**: Read `$WORKTREE/.claude/impl-plan.md` (if exists)
3. **Git diff**: Run `cd $WORKTREE && git diff $(git merge-base HEAD origin/main)..HEAD` (or appropriate base)
4. **Validate result**: Read `$WORKTREE/.claude/kickoff.json` → `phases.5_validate.result`
5. **Previous feedback**: Read `$WORKTREE/.claude/kickoff.json` → `phases.6_evaluate.iterations[]` (for retry context)

## Step 2: Detect Task Type

```bash
$SKILLS_DIR/dev-evaluate/scripts/detect-task-type.sh --worktree $WORKTREE [--issue-type <type>]
```

Pass the issue type from analyze result if available.

## Step 3: Load Evaluation Strategy

Read [Evaluation Strategies](references/evaluation-strategies.md) for the detected task type.
Apply `static_review` instructions. If `runtime_review` is defined (non-null), also apply those.

## Step 4: Score Implementation

Using [Scoring Framework](references/scoring-framework.md):

1. Score each **common criterion** (requirements, code_quality, edge_cases): 1-10
2. Score **type-specific criterion** if applicable: 1-10
3. Calculate total:
   - With type-specific: `total = (avg(common) × 0.7) + (type_specific × 0.3)`
   - Generic: `total = avg(common)`

## Step 5: Determine Verdict

- `total >= threshold (default 7.0)` → verdict: **pass**
- `total < threshold` → verdict: **fail**
  - Classify feedback_level: **design** or **implementation** (see scoring-framework.md)

## Step 6: Output JSON

Print the evaluation result as JSON to stdout. This is the return value to the caller (dev-kickoff).

```json
{
  "verdict": "pass",
  "score": {
    "requirements": 8,
    "code_quality": 7,
    "edge_cases": 6,
    "type_specific": 7
  },
  "total": 7.0,
  "threshold": 7.0,
  "feedback": [],
  "feedback_level": "implementation",
  "task_type": "api"
}
```

For `verdict: "fail"`, `feedback` MUST contain specific, actionable items describing what needs to change.

## Important

- **No access to implementation context**: You only see the diff, plan, and test results. This is by design.
- **Be specific in feedback**: Vague feedback like "improve code quality" is useless. Point to specific files, functions, or patterns.
- **Score honestly**: The purpose is to catch real issues before commit, not to rubber-stamp.
- **feedback_level matters**: It determines whether the retry goes to the Planner (design) or Generator (implementation).

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On pass (verdict: pass)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-evaluate success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On fail verdict (not an error — evaluation completed but implementation failed quality gate)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-evaluate success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On evaluation error (script crash, missing inputs, etc.)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-evaluate failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

Note: A "fail" verdict is a successful evaluation — the evaluator did its job. Only log as failure when the evaluation process itself errors.

## References

- [Scoring Framework](references/scoring-framework.md) - Detailed scoring criteria
- [Evaluation Strategies](references/evaluation-strategies.md) - Per-type review strategies
