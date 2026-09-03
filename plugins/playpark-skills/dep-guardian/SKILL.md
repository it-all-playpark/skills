---
name: dep-guardian
description: |
  Automate dependency update PR triage, testing, and batch merging.
  Use when: (1) renovate/dependabot PRs need processing, (2) dependency updates piling up,
  (3) batch merge safe updates, (4) keywords: dependency update, renovate, dependabot, deps, ライブラリ更新
  Accepts args: [--label <label>] [--auto-merge] [--dry-run] [--risk-threshold patch|minor|major]
allowed-tools:
  - Bash
  - Skill
---

# dep-guardian

Triage, test, and batch-merge dependency update PRs.

## Usage

```
/dep-guardian [--label <label>] [--auto-merge] [--dry-run] [--risk-threshold patch|minor|major]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--label` | `dependencies` | PR label filter |
| `--auto-merge` | false | Auto-merge PRs that pass all checks |
| `--dry-run` | false | Show plan without executing |
| `--risk-threshold` | `minor` | Max risk level for auto-merge |

## Workflow

```
1. DISCOVER  → scripts/discover-prs.sh
2. CLASSIFY  → scripts/classify-pr.sh (per PR)
3. SORT      → LLM sorts by risk (safest first)
4. TEST      → scripts/test-pr.sh (per PR, in risk order)
5. REPORT    → LLM generates summary table
6. MERGE     → scripts/merge-prs.sh (if --auto-merge)
```

## Phase 1: Discover

```bash
$SKILLS_DIR/dep-guardian/scripts/discover-prs.sh [--label LABEL]
# Output: {"status":"ok","label":"dependencies","count":N,"prs":[...]}
```

## Phase 2: Classify

For each PR from Phase 1:

```bash
$SKILLS_DIR/dep-guardian/scripts/classify-pr.sh --title "PR_TITLE" --body "PR_BODY" [--is-dev-dep]
# Output: {"risk":"patch|minor|major|breaking","package":"name","from":"x.y.z","to":"a.b.c","is_dev_dep":bool}
```

### Risk Classification

| Risk | Criteria | Examples |
|------|----------|---------|
| `patch` | x.y.Z bump, no breaking changes | 1.2.3 → 1.2.4 |
| `minor` | x.Y.z bump, backward compatible | 1.2.3 → 1.3.0 |
| `major` | X.y.z bump, potential breaking | 1.2.3 → 2.0.0 |
| `breaking` | Known breaking change (from PR body/changelog) | Major with migration guide |

## Phase 3: Sort

LLM sorts classified PRs: `patch` → `minor` → `major` → `breaking`

Within same risk level: devDependencies first, then alphabetical.

## Phase 4: Test

For each PR (in risk order):

```bash
$SKILLS_DIR/dep-guardian/scripts/test-pr.sh <pr-number>
# Output: {"pr":N,"build":"pass|fail|skipped","test":"pass|fail|skipped","typecheck":"pass|fail|skipped","overall":"pass|fail","errors":[...]}
```

| Result | Action |
|--------|--------|
| All pass | Mark as safe to merge |
| Build fails | Mark as needs-attention, skip |
| Tests fail | Mark as needs-attention, record failures |
| Type check fails | Mark as needs-attention, record errors |

## Phase 5: Report

LLM generates a markdown summary table:

```markdown
## Dependency Update Report

**Date**: {YYYY-MM-DD}
**PRs analyzed**: 12
**Safe to merge**: 8
**Needs attention**: 4

### Safe to Merge (by risk)

| # | PR | Package | Risk | Build | Test | Types |
|---|-----|---------|------|-------|------|-------|
| 1 | #101 | lodash 4.17.21→4.17.22 | patch | pass | pass | pass |

### Needs Attention

| # | PR | Package | Risk | Issue |
|---|-----|---------|------|-------|
| 4 | #103 | react 18→19 | major | 3 type errors |
```

## Phase 6: Merge (if --auto-merge)

```bash
$SKILLS_DIR/dep-guardian/scripts/merge-prs.sh <pr-numbers-comma-separated> [--dry-run]
# Output: {"merged":[...],"skipped":[...],"errors":[...],"dry_run":bool}
```

Safety checks (enforced by script):
- PR CI status must be passing
- PR must not have "do not merge" label
- LLM enforces: risk level must be ≤ risk-threshold

## Error Handling

| Scenario | Action |
|----------|--------|
| No dependency PRs found | Report "no updates pending", exit 0 |
| gh CLI not authenticated | Error with auth instructions |
| Build/test timeout | Skip PR, mark as timeout |
| Merge conflict | Skip PR, report conflict |

## Journal Logging

On completion, log to skill-retrospective:

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dep-guardian success \
  --context "analyzed=$TOTAL,merged=$MERGED,skipped=$SKIPPED"
```

## References

- [Risk Matrix](references/risk-matrix.md) - Package risk classification details

## Examples

```bash
# Triage all dependency PRs
/dep-guardian

# Preview only
/dep-guardian --dry-run

# Auto-merge patches only
/dep-guardian --auto-merge --risk-threshold patch

# Custom label
/dep-guardian --label "npm-update"
```
