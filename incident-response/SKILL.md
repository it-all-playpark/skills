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
allowed-tools:
  - Task
  - Bash
  - Skill
---

# Incident Response

Parallel incident investigation via Agent Team. Three analysis lines (code, log, config) run concurrently with real-time cross-line coordination.

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<symptom>` | required | Symptom description text |
| `--since` | - | Incident start time (ISO 8601 or "30min ago") |
| `--deploy-ref` | - | Recent deploy git ref (diff analysis start point) |
| `--max-turns` | `25` | Team-wide turn budget (lower for urgency) |
| `--repo-path` | `.` | Target repository path |

## Workflow

```
Phase 1: Triage (incident-lead)         → Symptom analysis, timeline, line assignment
Phase 2: Parallel Investigation (team)   → 3 lines run concurrently with cross-line messaging
Phase 3: Root Cause Determination        → Integrate findings, build causality chain
Phase 4: Resolution Plan                 → Immediate/permanent/prevention recommendations
```

## Phase 1: Triage

incident-lead executes:

1. Organize symptoms: **what** (affected function/endpoint), **when** (`--since` or inferred), **severity** (all users / partial / intermittent)
2. Build initial timeline
3. Decide investigation lines to launch:
   - `--deploy-ref` present -> limit code-analyst scope to that diff
   - Log file path unknown -> log-analyst explores first
   - No config management tool -> config-analyst focuses on git diff of config files
4. Initialize state: `scripts/incident-state.sh init "$SYMPTOM" --since "$SINCE"`
5. Create TaskList entries, assign to each analyst

## Phase 2: Parallel Investigation

### Team Composition

| Role | Name | Agent Type | Line |
|------|------|-----------|------|
| Leader | `incident-lead` | general-purpose | Triage, integration, decisions, user reporting |
| Code | `code-analyst` | root-cause-analyst | Code changes, deploy diffs, git blame |
| Log | `log-analyst` | root-cause-analyst | Log files, error patterns, metrics |
| Config | `config-analyst` | root-cause-analyst | Config files, env vars, infra changes |

Create team with TeamCreate, spawn analysts via Task tool. See [Team Lifecycle](references/team-lifecycle.md) for patterns.

### Investigation Line Details

Each analyst follows specialized procedures. See [Investigation Lines](references/investigation-lines.md) for:
- code-analyst: git diff, git log --since, git blame, impact analysis
- log-analyst: log file discovery, time-series analysis, error pattern extraction
- config-analyst: config diff, env var check, infra (Docker/K8s/Terraform) inspection

### Cross-Line Coordination

Analysts share findings via SendMessage. Key pattern:

```
log-analyst → code-analyst:
  "DB queries to 'users' table 10x slower since 15:30.
   Any DB-related code changes around 15:30?"

code-analyst → log-analyst:
  "commit abc123 (15:28) removed composite index on users table.
   Can you check slow query logs for that table?"

config-analyst → incident-lead:
  "No changes to DB connection settings, max_connections, or timeouts.
   Infra cause unlikely."
```

### Dynamic Adjustment (incident-lead)

- log-analyst finds "DB slow since 15:30" -> tell code-analyst "focus on DB commits around 15:30"
- code-analyst finds "index deletion commit" -> tell log-analyst "check slow queries for that table"
- config-analyst reports "no changes" -> send shutdown_request (cost saving)
- Strong lead found -> narrow remaining analysts' scope

### Cost Control

- `--max-turns` limits total team turns
- Early shutdown for analysts with no findings (typically config-analyst)
- Leader dynamically reallocates turn budget
- Check budget: `scripts/incident-state.sh check-budget`

## Phase 3: Root Cause Determination

incident-lead integrates all findings:

1. Merge all analyst findings into timeline (`scripts/incident-state.sh add-timeline`)
2. Build causal chain on timeline
3. Determine root cause with confidence level (High/Medium/Low)

## Phase 4: Resolution Plan

Generate three-tier resolution:

1. **Immediate**: rollback (`git revert`), feature flag disable, hotfix, scale-up
2. **Permanent**: code fix PR, migration strategy, architecture improvement
3. **Prevention**: CI checks, monitoring alerts, review process improvements

See [Resolution Patterns](references/resolution-patterns.md) for templates.

## State Management

State persisted in `$CWD/.claude/incident-state.json`.

```bash
# Initialize
scripts/incident-state.sh init "<symptom>" [--since <datetime>]

# Add timeline event
scripts/incident-state.sh add-timeline "<time>" "<event>" "<source>" "<severity>"

# Update investigation line status
scripts/incident-state.sh update-line <line> <status>

# Check turn budget
scripts/incident-state.sh check-budget

# Read current state
scripts/incident-state.sh read
```

## Output Format

```markdown
## Incident Response Report

### Summary
- **Symptom**: [1-sentence summary]
- **Occurred**: [datetime]
- **Root Cause**: [1-sentence summary]
- **Confidence**: High / Medium / Low

### Timeline
| Time | Event | Source | Severity |
|------|-------|--------|----------|
| 15:28 | index deletion commit | code-analyst | High |
| 15:30 | DB query 10x slowdown | log-analyst | Critical |

### Root Cause Analysis
[Detailed causal chain explanation]

### Immediate Action
[rollback/hotfix commands]

### Permanent Fix
[Fix PR proposal]

### Prevention Measures
1. [CI/monitoring/process improvement proposals]
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Log files not found | log-analyst reports, explores alternatives (stdout, journalctl) |
| No/shallow git history | code-analyst works with available info |
| max-turns reached | Report current findings (partial results are still useful) |
| Root cause not identified | Present additional info request list to user |
| Analyst stuck | incident-lead redefines investigation direction |

## Journal Logging

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log incident-response success \
  --context "lines=code,log,config"

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log incident-response failure \
  --error-category runtime --error-msg "<message>"
```

## References

- [Team Lifecycle](references/team-lifecycle.md) - Agent Team lifecycle patterns
- [Investigation Lines](references/investigation-lines.md) - Detailed procedures per analysis line
- [Resolution Patterns](references/resolution-patterns.md) - Immediate/permanent/prevention pattern templates
