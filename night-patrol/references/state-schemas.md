# Night Patrol State & Data Schemas

## State file: `.claude/night-patrol.json`

Initialized in Phase 0, updated throughout execution.

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

### `status` values

| Phase | Status values |
|-------|--------------|
| 0 | `initialized` |
| 1 | `scanning` |
| 2 | `triaging` |
| 3 | `executing` |
| 4 | `reporting` -> `done` |

### `results[]` entry

```json
{
  "issue_number": 123,
  "title": "Fix type error in utils.ts",
  "priority": "high",
  "status": "completed|failed|skipped",
  "pr_number": 456,
  "lines_changed": 42,
  "reason": "optional skip/fail reason"
}
```

## Scan results: `.claude/scan-results.json`

Output of Phase 1, input to Phase 2.

```json
{
  "scan_date": "<ISO timestamp>",
  "mode": "normal|deep",
  "sources": {
    "lint": [{"file": "...", "line": N, "rule": "...", "message": "..."}],
    "tests": [{"file": "...", "test": "...", "error": "..."}],
    "issues": [{"number": N, "title": "...", "labels": [...], "body": "..."}],
    "audit": [{"file": "...", "finding": "...", "severity": "..."}]
  },
  "counts": {"lint": N, "tests": N, "issues": N, "audit": N, "total": N}
}
```

Note: `audit` source is only present in `--deep` mode.

## Triage results: `.claude/triage-results.json`

Output of Phase 2, input to Phase 3.

```json
{
  "issues": [
    {
      "issue_number": 123,
      "title": "...",
      "source": "lint|tests|issues|audit",
      "priority": "critical|high|medium|low",
      "estimated_lines": N,
      "files": ["file1.ts", "file2.ts"],
      "dependencies": [456]
    }
  ],
  "execution_plan": {
    "batches": [
      {"batch": 1, "mode": "parallel|serial", "issues": [123, 124]},
      {"batch": 2, "mode": "serial", "issues": [125]}
    ]
  },
  "skipped": [
    {"issue_number": 126, "reason": "exceeds max_lines_per_issue"}
  ],
  "stats": {
    "total_found": N,
    "duplicates": N,
    "new_created": N,
    "skipped": N,
    "to_execute": N
  }
}
```
