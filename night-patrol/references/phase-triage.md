# Phase 2: Triage - Detailed Steps

Update state: `phase: 2, status: "triaging"`

Read `.claude/scan-results.json`.

## Step 1: Duplicate check

```bash
$SKILLS_DIR/night-patrol/scripts/check-duplicates.sh
```

LLM compares each scan finding (lint/tests/audit sources) against open issues:
- **Duplicate**: skip, add existing issue number to processing list
- **Partial duplicate**: add comment to existing issue via `gh issue comment`, skip
- **New**: proceed to grouping

## Step 2: Grouping (A/B/audit sources only)

LLM groups related findings into logical issues:
- Same file, same category -> 1 issue
- Related files, same root cause -> 1 issue
- Each group gets a title and description

## Step 3: Safety guard filter

For each candidate issue, run:

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-triage \
  --files "file1.ts,file2.ts" \
  --labels "label1,label2" \
  --estimated-lines N
```

If `pass: false` -> add to skipped list with reasons.

LLM also checks for breaking changes (public API changes, DB migrations).

## Step 4: Priority scoring

LLM assigns priority to each issue:

| Priority | Criteria |
|----------|----------|
| critical | Test failures, security vulnerabilities |
| high | Type errors, bug issues |
| medium | Lint warnings, enhancement issues |
| low | TODO/FIXME, cosmetic |

## Step 5: Dependency analysis

```bash
$SKILLS_DIR/night-patrol/scripts/analyze-dependencies.sh --issues-json .claude/triage-issues.json
```

LLM adds logical dependency analysis on top of file overlap data.
Generates execution plan with parallel batches and serial chains.

## Step 6: Issue creation

For new findings only (not existing GitHub issues):

```bash
gh issue create --title "TITLE" --body "BODY" --label "night-patrol,PRIORITY"
```

## Output

Write `.claude/triage-results.json` with issues, execution_plan, skipped, stats.
See [State Schemas](state-schemas.md) for the full JSON structure.

If `--dry-run` flag, skip to Phase 4 (Report) instead of Phase 3.
If subcommand is `triage`, stop here.
