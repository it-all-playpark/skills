# Execution Detail

Detailed operational patterns for incident-response skill.

## Cross-Line Coordination

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

## Dynamic Adjustment (incident-lead)

- log-analyst finds "DB slow since 15:30" -> tell code-analyst "focus on DB commits around 15:30"
- code-analyst finds "index deletion commit" -> tell log-analyst "check slow queries for that table"
- config-analyst reports "no changes" -> send shutdown_request (cost saving)
- Strong lead found -> narrow remaining analysts' scope

## State Write Ownership

**Only incident-lead writes to state file.** Analysts report findings via SendMessage to incident-lead, who consolidates and writes state. This prevents concurrent write conflicts when multiple analysts run in parallel.

## Cost Control

- `--max-turns` limits total team turns
- Early shutdown for analysts with no findings (typically config-analyst)
- Leader dynamically reallocates turn budget
- Check budget: `scripts/incident-state.sh check-budget`

## State Management

State persisted in `$CWD/.claude/incident-state.json`. When `--repo-path` is specified, run all scripts from that directory so `$CWD` resolves correctly.

```bash
# Initialize
scripts/incident-state.sh init "<symptom>" [--since <datetime>]

# Add timeline event
scripts/incident-state.sh add-timeline "<time>" "<event>" "<source>" "<severity>"

# Update investigation line status
scripts/incident-state.sh update-line <line> <status>

# Increment turn counter
scripts/incident-state.sh increment-turns [count]

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
