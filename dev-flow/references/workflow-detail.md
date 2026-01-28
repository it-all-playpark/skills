# Dev Flow - Workflow Details

Detailed documentation for the dev-flow skill workflow.

## Architecture

```
dev-flow (wrapper)
    │
    ├─→ Step 1: dev-kickoff (orchestrator)
    │       ├─→ Phase 1: git-prepare.sh (worktree)
    │       ├─→ Phase 2: dev-issue-analyze (exploration)
    │       ├─→ Phase 3: dev-implement (coding)
    │       ├─→ Phase 4: dev-validate (testing)
    │       ├─→ Phase 5: git-commit (commit)
    │       └─→ Phase 6: git-pr (PR creation)
    │
    ├─→ Step 2: Get PR URL
    │       └─→ gh pr view --json url --jq .url
    │
    └─→ Step 3: pr-iterate (review loop)
            └─→ Review → Fix → Push → Repeat
```

## State Flow

### State Files

| File | Location | Purpose |
|------|----------|---------|
| kickoff.json | `$WORKTREE/.claude/kickoff.json` | Phase tracking, PR info |
| iterate.json | `$WORKTREE/.claude/iterate.json` | Iteration count, review status |

### Phase Progression

```
1_prepare → 2_analyze → 3_implement → 4_validate → 5_commit → 6_pr → completed
```

Each phase transition is recorded by `update-phase.sh` which:
1. Sets current phase status to "done"
2. Advances `current_phase` to next
3. Records timestamp and result

## Step 1: dev-kickoff

The orchestrator handles 6 phases internally. See [dev-kickoff/SKILL.md](../../dev-kickoff/SKILL.md).

### Completion Signal

When Phase 6 (PR creation) completes, kickoff.json is updated with:
- `pr.number`: PR number
- `pr.url`: Full PR URL
- `next_action`: "pr-iterate"
- `current_phase`: "completed"

## Step 2: Get PR URL

Simple extraction from GitHub CLI:

```bash
gh pr view --json url --jq .url
```

Alternative via kickoff.json:
```bash
jq -r '.pr.url' $WORKTREE/.claude/kickoff.json
```

## Step 3: pr-iterate

Handles the review-fix-push loop. See [pr-iterate/SKILL.md](../../pr-iterate/SKILL.md).

### Input Sources

pr-iterate can receive PR reference from:
1. Direct argument: `pr-iterate https://github.com/org/repo/pull/123`
2. kickoff.json auto-detection (checks `.next_action == "pr-iterate"`)

## Recovery After Auto-Compact

When Claude auto-compacts, context is lost. To recover:

1. **Identify Worktree**
   ```bash
   # List recent worktrees
   ls -lt ~/ghq/github.com/*/*-worktrees/
   ```

2. **Check State**
   ```bash
   ~/.claude/skills/dev-flow/scripts/flow-status.sh --worktree $PATH
   ```

3. **Resume**
   - Follow `next_action` from output
   - State file preserves all progress

## Error Handling

| Scenario | Action |
|----------|--------|
| Phase fails in kickoff | kickoff.json records error, stops |
| PR creation fails | Manual `gh pr create`, then update state |
| pr-iterate fails | Check iterate.json, retry or manual fix |
| State file missing | Cannot recover, start fresh |

## Debugging

Check each state file:

```bash
# Kickoff state
cat $WORKTREE/.claude/kickoff.json | jq '.'

# Current phase
cat $WORKTREE/.claude/kickoff.json | jq '.current_phase, .phases'

# PR info
cat $WORKTREE/.claude/kickoff.json | jq '.pr'
```

## Integration Points

### With dev-kickoff
- dev-flow calls dev-kickoff as first step
- Waits for PR URL to be available
- kickoff.json is the handoff point

### With pr-iterate
- dev-flow extracts PR URL from kickoff or gh CLI
- Passes URL to pr-iterate
- pr-iterate creates its own iterate.json

### With GitHub CLI
- `gh pr view` for PR status
- `gh pr checks` for CI status
- `gh pr merge` - User performs manually after LGTM (not automated by this workflow)
