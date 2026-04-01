---
name: night-patrol
description: |
  Autonomous code patrol - scan, triage, implement, and report.
  Use when: (1) 自律巡回開発, (2) keywords: night patrol, 夜間巡回, 自動修正, 自律開発
  Accepts args: [scan|triage|execute|report] [--dry-run] [--deep] [--max-issues N]
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Skill
  - Task
  - Agent
  - TaskCreate
  - TaskUpdate
---

# Night Patrol

自律巡回開発 -- コードベースをスキャンし、issue発見→作成→実装→PR→nightlyブランチマージを繰り返す。

## Usage

| Command | Description |
|---------|-------------|
| `/night-patrol` | フル実行 (Phase 0-4) |
| `/night-patrol scan` | Phase 1 のみ |
| `/night-patrol scan --deep` | Phase 1 (code-audit-team 使用) |
| `/night-patrol triage` | Phase 2 のみ (scan-results.json 必要) |
| `/night-patrol execute` | Phase 3 のみ (triage-results.json 必要) |
| `/night-patrol report` | Phase 4 のみ (night-patrol.json 必要) |
| `/night-patrol --dry-run` | Phase 1-2 + レポートのみ |
| `/night-patrol --max-issues N` | 処理issue数の上限指定 |

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| サブコマンド | (なし=フル実行) | `scan`, `triage`, `execute`, `report` で個別Phase実行 |
| `--dry-run` | false | Phase 2 まで実行し、レポートのみ出力 |
| `--deep` | false | Phase 1 で code-audit-team を使った多角的スキャン (コスト高) |
| `--max-issues` | unlimited | 処理するissue数の上限 |

## Workflow

```
Phase 0: Init → Phase 1: Scan → Phase 2: Triage → Phase 3: Execute → Phase 4: Report
```

| Phase | Action | Complete When |
|-------|--------|---------------|
| 0 | 初期化 (nightly branch, state file) | branch created |
| 1 | Scan (scripts or code-audit-team) | scan-results.json exists |
| 2 | Triage (dedup, group, prioritize, plan) | triage-results.json exists |
| 3 | Execute (dev-flow per issue, batch) | all batches processed |
| 4 | Report (markdown + Telegram) | report sent |

## Phase 0: Initialize

1. Load config: `Read skill-config.json` -> `night-patrol` section
2. Set DATE to today (`date +%Y-%m-%d`)
3. Create nightly branch:

```bash
git fetch origin dev
git checkout -b nightly/$DATE origin/dev
git push -u origin nightly/$DATE
```

4. Initialize state file `.claude/night-patrol.json`:

```json
{
  "date": "$DATE",
  "branch": "nightly/$DATE",
  "status": "initialized",
  "phase": 0,
  "issues_total": 0,
  "issues_completed": 0,
  "issues_failed": 0,
  "issues_skipped": 0,
  "cumulative_lines_changed": 0,
  "results": []
}
```

5. If subcommand specified (`scan`, `triage`, `execute`, `report`), jump to that Phase directly.

## Phase 1: Scan

Update state: `phase: 1, status: "scanning"`

### Normal mode (default)

Run 3 scan scripts in parallel:

```bash
$SKILLS_DIR/night-patrol/scripts/scan-lint.sh
$SKILLS_DIR/night-patrol/scripts/scan-tests.sh
$SKILLS_DIR/night-patrol/scripts/scan-issues.sh \
  --allowed-labels "$CONFIG.allowed_labels" \
  --denylist-labels "$CONFIG.denylist_labels" \
  --denylist-issues "$CONFIG.denylist_issues"
```

### --deep mode

Additionally invoke:

```
Skill(skill: "code-audit-team", args: "--scope project")
```

Parse code-audit-team output and extract findings into `audit` source.

### Merge results

Combine all script outputs into `.claude/scan-results.json`:

```json
{
  "scan_date": "<ISO timestamp>",
  "mode": "normal|deep",
  "sources": {
    "lint": [<scan-lint.sh output>],
    "tests": [<scan-tests.sh output>],
    "issues": [<scan-issues.sh output>],
    "audit": [<code-audit-team findings if --deep>]
  },
  "counts": {"lint": N, "tests": N, "issues": N, "audit": N, "total": N}
}
```

If subcommand is `scan`, stop here.

## Phase 2: Triage

Update state: `phase: 2, status: "triaging"`

Read `.claude/scan-results.json`.

### Step 1: Duplicate check

```bash
$SKILLS_DIR/night-patrol/scripts/check-duplicates.sh
```

LLM compares each scan finding (lint/tests/audit sources) against open issues:
- **Duplicate**: skip, add existing issue number to processing list
- **Partial duplicate**: add comment to existing issue via `gh issue comment`, skip
- **New**: proceed to grouping

### Step 2: Grouping (A/B/audit sources only)

LLM groups related findings into logical issues:
- Same file, same category -> 1 issue
- Related files, same root cause -> 1 issue
- Each group gets a title and description

### Step 3: Safety guard filter

For each candidate issue, run:

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-triage \
  --files "file1.ts,file2.ts" \
  --labels "label1,label2" \
  --estimated-lines N
```

If `pass: false` -> add to skipped list with reasons.

LLM also checks for breaking changes (public API changes, DB migrations).

### Step 4: Priority scoring

LLM assigns priority to each issue:

| Priority | Criteria |
|----------|----------|
| critical | Test failures, security vulnerabilities |
| high | Type errors, bug issues |
| medium | Lint warnings, enhancement issues |
| low | TODO/FIXME, cosmetic |

### Step 5: Dependency analysis

```bash
$SKILLS_DIR/night-patrol/scripts/analyze-dependencies.sh --issues-json .claude/triage-issues.json
```

LLM adds logical dependency analysis on top of file overlap data.
Generates execution plan with parallel batches and serial chains.

### Step 6: Issue creation

For new findings only (not existing GitHub issues):

```bash
gh issue create --title "TITLE" --body "BODY" --label "night-patrol,PRIORITY"
```

### Output

Write `.claude/triage-results.json` with issues, execution_plan, skipped, stats.

If `--dry-run` flag, skip to Phase 4 (Report) instead of Phase 3.
If subcommand is `triage`, stop here.

## Phase 3: Execute

Update state: `phase: 3, status: "executing"`

Read `.claude/triage-results.json`.

Apply `--max-issues` limit if set (take first N issues from execution plan).

### Batch loop

For each batch in `execution_plan.batches` (ordered by batch number):

1. **Pre-execute guard check:**

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute \
  --cumulative-lines $CUMULATIVE
```

If `pass: false` -> skip all remaining batches, proceed to Phase 4.

2. **Execute batch:**

**Parallel batch** (`mode: "parallel"`):
Launch each issue as a Task subagent:

```
Task: dev-flow <issue-number> --base nightly/$DATE
```

Wait for all to complete.

**Serial batch** (`mode: "serial"`):
Execute each issue sequentially:

```
Skill(skill: "dev-flow", args: "<issue-number> --base nightly/$DATE")
```

3. **Process results:**

For each completed issue:
- If dev-flow returned LGTM PR -> merge PR into `nightly/$DATE`
  ```bash
  gh pr merge <PR_NUMBER> --merge
  ```
- If max_reached or error -> record as skipped/failed

4. **Update state:** Add result to `results[]`, update counters in `.claude/night-patrol.json`.

### After all batches

Update state: `status: "completed"`

If subcommand is `execute`, stop here.

## Phase 4: Report

Update state: `phase: 4, status: "reporting"`

### Generate report

```bash
$SKILLS_DIR/night-patrol/scripts/generate-report.sh \
  --state .claude/night-patrol.json
```

Output: `claudedocs/night-patrol/$DATE.md`

### Telegram notification

Load `telegram_chat_id` from config. If set:

```
telegram reply --chat_id $CHAT_ID --text "Night Patrol 完了

${COMPLETED}件完了 / ${SKIPPED}件スキップ / ${FAILED}件失敗
${CUMULATIVE}行変更 (nightly/$DATE)

→ レポート: claudedocs/night-patrol/$DATE.md"
```

### Journal logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log night-patrol success \
  --context "scanned=$TOTAL,processed=$COMPLETED,skipped=$SKIPPED,failed=$FAILED"
```

Update state: `status: "done"`

## References

- [Safety Guards](references/safety-guards.md) - 安全ガード詳細 (denylist, 変更量上限, 破壊的変更検出)
