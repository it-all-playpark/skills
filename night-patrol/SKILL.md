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
4. Initialize state file `.claude/night-patrol.json`
5. If subcommand specified, jump to that Phase directly.

Details: [State Schemas](references/state-schemas.md)

## Phase 1: Scan

Update state: `phase: 1, status: "scanning"`

**Normal mode**: Run 3 scan scripts in parallel:

```bash
$SKILLS_DIR/night-patrol/scripts/scan-lint.sh
$SKILLS_DIR/night-patrol/scripts/scan-tests.sh
$SKILLS_DIR/night-patrol/scripts/scan-issues.sh \
  --allowed-labels "$CONFIG.allowed_labels" \
  --denylist-labels "$CONFIG.denylist_labels" \
  --denylist-issues "$CONFIG.denylist_issues"
```

**--deep mode**: Replace `scan-lint.sh` with `code-audit-team` (包含するため):

```
Skill(skill: "code-audit-team", args: "--scope project")
```

Merge all outputs into `.claude/scan-results.json`. If subcommand is `scan`, stop here.

Details: [State Schemas](references/state-schemas.md) - scan-results.json format

## Phase 2: Triage

Update state: `phase: 2, status: "triaging"`

1. **Duplicate check** - `scripts/check-duplicates.sh` + LLM comparison against open issues
2. **Grouping** - Related findings -> logical issues (same file/root cause)
3. **Safety guard filter** - `scripts/guard-check.sh --mode pre-triage` + breaking change detection
4. **Priority scoring** - critical/high/medium/low assignment
5. **Dependency analysis** - `scripts/analyze-dependencies.sh` + execution plan generation
6. **Issue creation** - `gh issue create` for new findings only

Output: `.claude/triage-results.json`. If `--dry-run`, skip to Phase 4. If subcommand is `triage`, stop here.

Details: [Triage Steps](references/phase-triage.md) | [State Schemas](references/state-schemas.md)

## Phase 3: Execute

Update state: `phase: 3, status: "executing"`

For each batch in `execution_plan.batches`:

1. **Pre-execute guard** - `guard-check.sh --mode pre-execute` (fail -> skip to Phase 4)
2. **Execute** - Parallel: `Task: dev-flow <issue> --base nightly/$DATE` / Serial: `Skill(dev-flow)`
3. **Auto-merge** - LGTM PR -> `gh pr merge <PR> --merge --admin --delete-branch`
4. **Post-issue guard** - Cumulative line check (fail -> skip remaining, proceed to Phase 4)
5. **Update state** - Record result, update counters

**Critical**: `--admin` bypasses confirmation. Safe because nightly branch is autonomous patrol only.

After all batches: `status: "completed"`. If subcommand is `execute`, stop here.

Details: [Execute Steps](references/phase-execute.md)

## Phase 4: Report

Update state: `phase: 4, status: "reporting"`

1. **Generate report** - `scripts/generate-report.sh` -> `claudedocs/night-patrol/$DATE.md`
2. **Telegram notification** - Send summary to `telegram_chat_id` (if configured)
3. **Journal logging** - `skill-retrospective/scripts/journal.sh log night-patrol success`

Update state: `status: "done"`

Details: [Report Steps](references/phase-report.md)

## References

- [Safety Guards](references/safety-guards.md) - 安全ガード詳細 (denylist, 変更量上限, 破壊的変更検出)
- [State Schemas](references/state-schemas.md) - JSON state file formats (night-patrol.json, scan-results.json, triage-results.json)
- [Triage Steps](references/phase-triage.md) - Phase 2 detailed step-by-step
- [Execute Steps](references/phase-execute.md) - Phase 3 batch loop details
- [Report Steps](references/phase-report.md) - Phase 4 report generation, Telegram, journal logging
