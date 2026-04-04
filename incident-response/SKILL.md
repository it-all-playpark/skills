---
name: incident-response
description: |
  Parallel incident investigation using Agent Team with code, log, and config analysis lines.
  Real-time cross-line coordination for rapid root cause identification.
  Use when: (1) production incident or degradation investigation, (2) sudden performance regression,
  (3) post-deploy issue analysis, (4) error spike investigation,
  (5) keywords: incident, 障害調査, production issue, 本番障害, エラー急増, レスポンス遅い,
  デプロイ後の不具合, postmortem, 原因特定
  Accepts args: <symptom> [--since <datetime>] [--deploy-ref <ref>] [--max-turns N] [--repo-path <path>]
model: opus
effort: high
allowed-tools:
  - Task
  - Bash
  - Skill
---

# Incident Response

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<symptom>` | required | Symptom description |
| `--since` | - | Start time (ISO 8601 / "30min ago") |
| `--deploy-ref` | - | Deploy git ref for diff scope |
| `--max-turns` | `25` | Team turn budget |
| `--repo-path` | `.` | Target repo path |

## Workflow

```
Phase 1: Triage → Phase 2: Parallel Investigation → Phase 3: Root Cause → Phase 4: Resolution
```

## Phase 1: Triage

incident-lead: classify symptom (what/when/severity), build timeline, decide lines to launch, initialize state (`scripts/incident-state.sh init "$SYMPTOM" --since "$SINCE"`), create TaskList entries.

Scope hints: `--deploy-ref` narrows code-analyst to that diff; unknown log paths trigger log-analyst exploration first; no config tool means config-analyst focuses on git diff of config files.

## Phase 2: Parallel Investigation

### Team

4 agents (all general-purpose): `incident-lead` (triage/integration), `code-analyst` (code/deploy diffs), `log-analyst` (logs/metrics), `config-analyst` (config/env/infra). Create with TeamCreate, spawn via Task. See [Team Lifecycle](references/team-lifecycle.md) and [Investigation Lines](references/investigation-lines.md).

### Cross-Line Coordination & Cost Control

Analysts share findings via SendMessage. incident-lead dynamically adjusts scope and shuts down idle analysts. **Only incident-lead writes to state file** (prevents concurrent write conflicts).

Details: [Execution Detail](references/execution-detail.md)

## Phase 3: Root Cause Determination

incident-lead merges findings into timeline (`scripts/incident-state.sh add-timeline`), builds causal chain, determines root cause with confidence (High/Medium/Low).

## Phase 4: Resolution Plan

Three tiers: **Immediate** (rollback/hotfix/scale-up), **Permanent** (code fix PR/architecture), **Prevention** (CI/monitoring/process). See [Resolution Patterns](references/resolution-patterns.md).

## State Management & Output

State persisted in `$CWD/.claude/incident-state.json`. Script commands and output report template: [Execution Detail](references/execution-detail.md)

## Journal Logging

`$SKILLS_DIR/skill-retrospective/scripts/journal.sh log incident-response {success|failure} [--context "lines=..."] [--error-category runtime --error-msg "..."]`

## References

- [Execution Detail](references/execution-detail.md) - Coordination, state management, output format, error handling
- [Team Lifecycle](references/team-lifecycle.md) - Agent Team lifecycle patterns
- [Investigation Lines](references/investigation-lines.md) - Detailed procedures per analysis line
- [Resolution Patterns](references/resolution-patterns.md) - Immediate/permanent/prevention pattern templates
