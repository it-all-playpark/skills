---
name: dev-implement
description: |
  Feature implementation with strategy selection and optional worktree isolation.
  Use when: implementing features, fixing bugs, refactoring code, building components.
  Accepts args: [feature] [--testing tdd|bdd] [--design ddd] [--type component|api|service]
    [--framework react|vue|express] [--worktree <path>] [--with-tests] [--safe]
model: sonnet
---

# Implement

Execute feature implementation with configurable strategy and context.

## Usage

```
/implement [feature] [options]
```

| Arg | Description |
|-----|-------------|
| feature | What to implement |
| --testing | Implementation approach: tdd (test-first, default), bdd (behavior-first) |
| --design | Design approach: ddd (domain modeling before implementation) |
| --type | component, api, service, feature |
| --framework | react, vue, express, etc. |
| --worktree | Path to worktree (for isolated development) |
| --with-tests | Include test generation |
| --safe | Extra validation gates |

## Strategy

Testing axis (`--testing`): tdd (default) or bdd. Design axis (`--design`): ddd (opt-in).
These are independent and composable (e.g. `--testing tdd --design ddd`).

Details: [Strategy Model](references/strategy-model.md)

## Workflow

```
1. Context & Stack Detection → 2. Design (if --design) → 3. Plan → 4. Implement → 5. Validate → 6. Review
```

### Step 1: Context & Stack Detection

Detect from codebase or args: framework/tech stack, existing patterns, project conventions.

**Best practice loading**:
If invoked from dev-kickoff workflow (dev-issue-analyze already loaded best practices
into context), skip detect-stack.sh -- the context already contains framework guidelines.

If invoked standalone (no prior dev-issue-analyze):
1. Run `$SKILLS_DIR/_lib/scripts/detect-stack.sh` to detect frameworks
2. For each detected skill in `rules_paths`, Read the corresponding SKILL.md

If `--worktree` provided, all operations within that path.

### Step 2: Design Phase (if --design ddd)

Execute domain modeling BEFORE implementation: identify entities/value objects, define aggregates/boundaries, map relationships, design domain-to-infrastructure mapping.

Details: [Strategy Model - DDD](references/strategy-model.md#design-strategy-details)

### Step 3: Plan Implementation

**impl-plan.md Check**: If `$WORKTREE/.claude/impl-plan.md` exists (created by dev-plan-impl),
follow that plan instead of creating your own. Do not re-plan from scratch.
If the plan has a "Notes for Retry" section, address the feedback noted there.

**Evaluator Feedback (retry mode)**: On retry, read `kickoff.json` → `phases.6_evaluate.iterations[]`
for the latest feedback. The `feedback` array contains specific issues to address.
The `feedback_level` indicates whether the issues are design-level (re-plan needed)
or implementation-level (re-implement within existing plan).

If `impl-plan.md` does NOT exist (standalone invocation), plan as before.
Check installed skills for tasks that match -- prefer Skill invocation over manual implementation.

Details: [Skill-Aware Planning](references/skill-aware-planning.md)

Based on `--testing` (default: tdd): tdd = Write tests first → Implement → Refactor. bdd = Define behavior specs → Implement → Verify.

Create TodoWrite items for tracking (>3 steps).

### Step 4: Implement

Select tools based on `--type`. Follow project conventions, maintain existing patterns, add error handling, include imports.

Details: [Tool Selection](references/tool-selection.md)

**Feature trace logging (kickoff.json 連携)**:

`$WORKTREE/.claude/kickoff.json` に `feature_list` が存在する場合（`dev-plan-impl` で初期化済）、各 feature 完了時に以下を必ず呼び出す:

```bash
# 着手時
$SKILLS_DIR/dev-kickoff/scripts/update-feature.sh \
  --worktree "$WORKTREE" --id "F1" --status in_progress

# 完了時
$SKILLS_DIR/dev-kickoff/scripts/update-feature.sh \
  --worktree "$WORKTREE" --id "F1" --status done

$SKILLS_DIR/dev-kickoff/scripts/append-progress.sh \
  --worktree "$WORKTREE" --phase "4" --note "F1 (feature desc) 完了、test green"
```

**Mandatory rules**:
- `feature_list[i].id` と `desc` は **書き換え禁止**。`update-feature.sh` は `status` のみ変更する。
- `Edit` ツールで kickoff.json の `feature_list` を直接書き換えない。必ずスクリプトを使う。
- `progress_log` は append-only。既存エントリに触れない。
- 後方互換: `feature_list` が未定義 or 空の場合（standalone 実行時など）はスキップして通常実装を続行する。

### Step 5: Validate

- [ ] Todos completed
- [ ] No TODO comments in code
- [ ] Types correct (TypeScript)
- [ ] Imports resolved
- [ ] Tests pass (if --with-tests)

### Step 6: Review

If `--safe`: security check on auth/data handling, input validation review, error handling coverage.

## Examples

Details: [Usage Examples](references/examples.md)

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-implement success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-implement failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

## Integration

- Receives context from `dev-issue-analyze` if in kickoff workflow
- Receives `WORKTREE_PATH` from `git-prepare` if worktree mode
- Passes to `dev-validate` skill for verification
- Reads `$WORKTREE/.claude/impl-plan.md` from `dev-plan-impl` if available
- Receives Evaluator feedback via kickoff.json iterations on retry
