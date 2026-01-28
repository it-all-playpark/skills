---
name: dev-flow
description: |
  End-to-end development flow automation - from issue to LGTM.
  Note: Merge is performed manually by the user after review approval.
  Use when: (1) complete development cycle needed, (2) issue to PR automation,
  (3) keywords: full flow, development cycle, issue to PR
  Accepts args: <issue-number> [--strategy tdd|bdd|ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--max-iterations N]
allowed-tools:
  - Skill
  - Bash
---

# Dev Flow

End-to-end development automation from issue to LGTM (merge manually).

## ⚠️ CRITICAL: Complete All Phases

**This workflow has 3 steps. DO NOT EXIT until pr-iterate completes.**

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-kickoff` | PR URL available |
| 2 | `gh pr view --json url` | URL captured |
| 3 | `Skill: pr-iterate` | LGTM achieved or max iterations |

## Usage

```
/dev-flow <issue> [--strategy tdd] [--depth comprehensive] [--base main] [--max-iterations 10]
```

## Workflow Checklist

Execute in order. Mark each complete before proceeding:

```
[ ] Step 1: Skill: dev-kickoff $ISSUE --strategy $STRATEGY --depth $DEPTH --base $BASE
[ ] Step 2: PR_URL=$(gh pr view --json url --jq .url)
[ ] Step 3: Skill: pr-iterate $PR_URL --max-iterations $MAX
```

## Completion Conditions

| Condition | Action |
|-----------|--------|
| pr-iterate completes | ✅ Workflow complete |
| LGTM achieved | ✅ Workflow complete (merge manually) |
| Max iterations reached | ⚠️ Report status, user decides |
| Any step fails | ❌ Report error, do not proceed |

## ⚠️ Important: No Auto-Merge

**This workflow does NOT merge the PR.** After achieving LGTM, the user should manually merge using `gh pr merge` or the GitHub UI.

## State Recovery

After auto-compact, check worktree state:

```bash
~/.claude/skills/dev-flow/scripts/flow-status.sh --worktree $WORKTREE
```

Output tells you the next action.

## References

- [Workflow Details](references/workflow-detail.md) - Full phase descriptions
- [dev-kickoff](../dev-kickoff/SKILL.md) - Orchestrator skill
- [pr-iterate](../pr-iterate/SKILL.md) - PR iteration skill
