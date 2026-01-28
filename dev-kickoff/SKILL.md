---
name: dev-kickoff
description: |
  End-to-end feature development orchestrator using git worktree. Coordinates git-prepare, issue-analyze, implement, validate, commit, and create-pr skills.
  Use when: starting new feature development from GitHub issue, full development cycle automation with isolated worktree.
  Accepts args: <issue-number> [--strategy tdd|bdd|ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--lang ja|en] [--env-mode hardlink|symlink|copy|none]
allowed-tools:
  - Bash
  - TodoWrite
---

# Kickoff

Orchestrate complete feature development cycle from issue to PR.

## ⚠️ CRITICAL: Complete All 6 Phases

**DO NOT EXIT until Phase 6 (PR creation) completes and pr-iterate is called.**

| Phase | Action | Complete When |
|-------|--------|---------------|
| 1 | Worktree creation | Path exists, .env verified |
| 2 | Issue analysis | Requirements understood |
| 3 | Implementation | Code written |
| 4 | Validation | Tests pass |
| 5 | Commit | Changes committed |
| 6 | PR creation | PR URL available |

After Phase 6: Call `Skill: pr-iterate $PR_URL` to complete the workflow.

## Phase Checklist

```
[ ] Phase 1: git-prepare.sh → init-kickoff.sh
[ ] Phase 2: Skill: dev-issue-analyze
[ ] Phase 3: Skill: dev-implement
[ ] Phase 4: Skill: dev-validate --fix
[ ] Phase 5: Skill: git-commit --all
[ ] Phase 6: Skill: git-pr → pr-iterate
```

## State Management

State persisted in `$WORKTREE/.claude/kickoff.json` for recovery.

### Initialize (After Phase 1)

```bash
~/.claude/skills/dev-kickoff/scripts/init-kickoff.sh $ISSUE $BRANCH $WORKTREE \
  --base $BASE --strategy $STRATEGY --depth $DEPTH --lang $LANG --env-mode $ENV_MODE
```

### Update Phase Status

```bash
# Start phase
~/.claude/skills/dev-kickoff/scripts/update-phase.sh <phase> in_progress --worktree $PATH

# Complete phase
~/.claude/skills/dev-kickoff/scripts/update-phase.sh <phase> done --result "Summary" --worktree $PATH

# After PR creation (Phase 6)
~/.claude/skills/dev-kickoff/scripts/update-phase.sh 6_pr done \
  --result "PR created" --pr-number 123 --pr-url "URL" --worktree $PATH
```

## Phase Execution

| Phase | Command | Subagent |
|-------|---------|----------|
| 1 | `~/.claude/skills/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE --env-mode $ENV_MODE` | - |
| 1b | `~/.claude/skills/dev-kickoff/scripts/init-kickoff.sh ...` | - |
| 2 | `Skill: dev-issue-analyze $ISSUE --depth $DEPTH` | Task(Explore) |
| 3 | `Skill: dev-implement --strategy $STRATEGY --worktree $PATH` | - |
| 4 | `Skill: dev-validate --fix --worktree $PATH` | Task(quality-engineer) |
| 5 | `Skill: git-commit --all --worktree $PATH` | - |
| 6 | `Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH` | - |

⚠️ **Phase 1: 必ずスクリプト実行。`git worktree add` 直接実行禁止。**

## Phase 1 Verification

```bash
ls $WORKTREE/.env || echo "ERROR: .env not linked"
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--strategy` | `tdd` | Implementation strategy |
| `--depth` | `standard` | Analysis depth |
| `--base` | `main` | PR base branch |
| `--lang` | `ja` | PR language |
| `--env-mode` | `hardlink` | Env file handling |

## Error Handling

| Phase | On Failure |
|-------|------------|
| 1-2 | Abort, update state |
| 3 | Pause for intervention |
| 4 | Retry with --fix |
| 5-6 | Report command, save state |

## References

- [Phase Details](references/phase-detail.md) - Detailed phase documentation
- [State Schema](references/phase-detail.md#state-schema) - kickoff.json format
