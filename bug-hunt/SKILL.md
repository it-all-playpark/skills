---
name: bug-hunt
description: |
  Collaborative multi-agent bug investigation using Agent Team.
  Generates hypotheses, investigates in parallel, dynamically redirects based on findings.
  Use when: (1) complex bugs with unclear root cause, (2) intermittent/hard-to-reproduce issues,
  (3) multi-component bugs crossing module boundaries,
  (4) keywords: bug hunt, root cause, investigate, debug, intermittent failure, flaky test,
  原因調査, なぜ落ちる, 再現しない, 時々失敗
  Accepts args: <issue-or-description> [--max-hypotheses N] [--max-turns N] [--repo-path <path>]
allowed-tools:
  - Task
  - Bash
  - Skill
---

# Bug Hunt

Collaborative multi-agent bug investigation with dynamic hypothesis management.

## Usage

```
/bug-hunt <issue-or-description> [--max-hypotheses N] [--max-turns N] [--repo-path <path>]
```

## Prerequisites

- `jq` - Required for state file management (`brew install jq`)

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-or-description>` | required | GitHub issue number or symptom text |
| `--max-hypotheses` | `8` | Maximum hypotheses tracked simultaneously |
| `--max-turns` | `30` | Team turn budget (cost control) |
| `--repo-path` | `.` | Target repository path |

## Workflow

```
Phase 1: Triage (hunt-lead)
  ├── Analyze and categorize symptoms
  ├── Generate 3-5 initial hypotheses
  ├── Create TaskList verification tasks
  └── Assign to investigators

Phase 2: Investigate (parallel, dynamic)
  ├── Each investigator verifies assigned hypothesis
  ├── Findings → SendMessage to hunt-lead
  ├── hunt-lead adds/rejects/redirects hypotheses
  └── Real-time investigator redirection

Phase 3: Converge (hunt-lead)
  ├── Declare root cause identification
  ├── Build evidence chain
  └── Instruct fix-proposer

Phase 4: Propose Fix (fix-proposer)
  ├── Create fix code proposal
  ├── Create regression test cases
  └── hunt-lead reviews → present to user
```

## Team Composition

| Role | Name | Agent Type | Responsibility |
|------|------|-----------|----------------|
| Leader | `hunt-lead` | general-purpose | Hypothesis generation, priority management, convergence |
| Investigator 1 | `investigator-1` | Explore | Code investigation, hypothesis verification |
| Investigator 2 | `investigator-2` | Explore | Parallel investigation line |
| Fix Proposer | `fix-proposer` | general-purpose | Fix proposal after root cause identified |

Cost control: For simple bugs, start with investigator-1 only. Spawn investigator-2 when multiple hypotheses need parallel work. Spawn fix-proposer only after root cause is confirmed.

## Phase 1: Triage

hunt-lead executes:

1. Parse issue number (fetch via `gh issue view`) or symptom text
2. Get code area overview via Explore agent
3. Generate initial hypotheses from categories (see [hypothesis-categories.md](references/hypothesis-categories.md))
4. Create TaskList tasks with verification steps per hypothesis
5. Assign to investigator-1 (and investigator-2 if >= 3 hypotheses)

### Initialize State

```bash
$SKILLS_DIR/bug-hunt/scripts/hunt-state.sh init \
  --target "<issue or description>" \
  --max-hypotheses N --max-turns N \
  --repo-path <path>
```

## Phase 2: Investigate

Each investigator:
- Follow assigned hypothesis verification steps
- Use Grep/Read/Bash to collect evidence
- SendMessage findings to hunt-lead

hunt-lead dynamic adjustments:
- Hypothesis rejected -> assign next hypothesis to investigator
- New hypothesis emerges -> add to TaskList, assign to available investigator
- Strong lead found -> redirect other investigator to related area
- Both investigators on same area -> redirect one to different hypothesis

```bash
# Add hypothesis
$SKILLS_DIR/bug-hunt/scripts/hunt-state.sh add-hypothesis \
  --id "h3" --description "Race condition in session handler" \
  --category "state" --assigned-to "investigator-1"

# Update hypothesis
$SKILLS_DIR/bug-hunt/scripts/hunt-state.sh update-hypothesis \
  --id "h1" --status "rejected" \
  --reason "Session store uses Redis, no memory leak"
```

### Turn Tracking

Increment turns_used after each investigator message:

```bash
$SKILLS_DIR/bug-hunt/scripts/hunt-state.sh increment-turn --repo-path <path>
```

### Convergence Conditions

- Root cause identified with sufficient evidence
- Reproduction steps established
- All hypotheses rejected (request additional info from user)

### Budget Check

```bash
$SKILLS_DIR/bug-hunt/scripts/hunt-state.sh check-budget --repo-path <path>
```

## Phase 3: Converge

hunt-lead produces:
1. One-sentence root cause summary
2. Evidence chain with file:line references
3. Impact assessment

## Phase 4: Propose Fix

fix-proposer creates:
1. Fix code proposal for root cause
2. Regression test cases
3. Similar-area impact check

## State Management

State persisted in `$CWD/.claude/bug-hunt-state.json`. See [team-lifecycle.md](references/team-lifecycle.md) for Team patterns.

```bash
# Read current state
$SKILLS_DIR/bug-hunt/scripts/hunt-state.sh read --repo-path <path>
```

## Output Format

```markdown
## Bug Hunt Report

### Root Cause
[One-sentence summary]

### Evidence Chain
1. [file:line] - [finding]
2. [file:line] - [finding]

### Hypotheses Investigated
| # | Hypothesis | Result | Evidence |
|---|-----------|--------|----------|
| 1 | ... | Confirmed/Rejected | ... |

### Proposed Fix
[Fix code proposal]

### Regression Test
[Test case proposal]

### Impact Assessment
[Affected scope]
```

## Error Handling

| Scenario | Action |
|----------|--------|
| All hypotheses rejected | Request additional info from user, attempt new hypotheses |
| max-turns reached | Report current findings and exit |
| Investigator stuck | hunt-lead redefines hypothesis, suggests different approach |
| Team communication error | Recover via file-based state, reconstruct Team |

## Journal Logging

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log bug-hunt success \
  --issue $ISSUE --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log bug-hunt failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

## References

- [Team Lifecycle](references/team-lifecycle.md) - Agent Team lifecycle patterns
- [Hypothesis Categories](references/hypothesis-categories.md) - Bug hypothesis categories and verification approaches
