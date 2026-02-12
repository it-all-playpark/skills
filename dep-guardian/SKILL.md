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
1. DISCOVER  → List dependency update PRs via gh CLI
2. CLASSIFY  → Categorize by risk (patch/minor/major/breaking)
3. SORT      → Order by risk (safest first)
4. TEST      → Checkout, build, test each PR
5. REPORT    → Generate summary with pass/fail status
6. MERGE     → Batch merge passed PRs (if --auto-merge)
```

## Phase 1: Discover

```bash
gh pr list --label "$LABEL" --state open --json number,title,headRefName,labels,body --limit 50
```

## Phase 2: Classify

### Risk Classification

| Risk | Criteria | Examples |
|------|----------|---------|
| `patch` | x.y.Z bump, no breaking changes | 1.2.3 → 1.2.4 |
| `minor` | x.Y.z bump, backward compatible | 1.2.3 → 1.3.0 |
| `major` | X.y.z bump, potential breaking | 1.2.3 → 2.0.0 |
| `breaking` | Known breaking change (from PR body/changelog) | Major with migration guide |

### Detection Logic

1. Parse version bump from PR title (renovate/dependabot format)
2. Check PR body for "breaking change" keywords
3. Check if package is in devDependencies (lower risk) vs dependencies
4. Cross-reference with [risk matrix](references/risk-matrix.md)

## Phase 3: Sort

Process order: `patch` → `minor` → `major` → `breaking`

Within same risk level, sort by:
1. devDependencies first (lower blast radius)
2. Alphabetical by package name

## Phase 4: Test

For each PR (in risk order):

```bash
# Checkout PR branch
gh pr checkout $PR_NUMBER

# Install dependencies
~/.claude/skills/dev-env-setup/scripts/detect-and-install.sh --path .

# Build
npm run build 2>&1 || echo "BUILD_FAILED"

# Test
npm test 2>&1 || echo "TEST_FAILED"

# Type check (if TypeScript)
npx tsc --noEmit 2>&1 || echo "TYPE_CHECK_FAILED"

# Return to original branch
git checkout -
```

| Result | Action |
|--------|--------|
| All pass | Mark as safe to merge |
| Build fails | Mark as needs-attention, skip |
| Tests fail | Mark as needs-attention, record failures |
| Type check fails | Mark as needs-attention, record errors |

## Phase 5: Report

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
| 2 | #102 | typescript 5.3.2→5.3.3 | patch | pass | pass | pass |
| 3 | #105 | next 14.1.0→14.2.0 | minor | pass | pass | pass |

### Needs Attention

| # | PR | Package | Risk | Issue |
|---|-----|---------|------|-------|
| 4 | #103 | react 18→19 | major | 3 type errors |
| 5 | #104 | eslint 8→9 | major | Config migration needed |
```

## Phase 6: Merge (if --auto-merge)

```bash
# Only merge PRs within risk threshold
for pr in $SAFE_PRS; do
    gh pr merge $pr --squash --auto
done
```

Safety checks before merge:
- PR CI status must be passing
- Risk level must be ≤ risk-threshold
- PR must not have "do not merge" label

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
~/.claude/skills/skill-retrospective/scripts/journal.sh log dep-guardian success \
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
