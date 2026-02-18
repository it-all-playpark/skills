# Agent Team Lifecycle

Common patterns for Agent Team coordination in investigation workflows.

## Table of Contents

- [Team Setup](#team-setup)
- [Agent Spawning](#agent-spawning)
- [Communication Patterns](#communication-patterns)
- [Dynamic Adjustment](#dynamic-adjustment)
- [Early Shutdown](#early-shutdown)
- [Teardown](#teardown)

## Team Setup

```bash
# 1. Create team
TeamCreate: team_name="incident-{symptom-slug}", description="Investigating: {symptom}"

# 2. Create investigation tasks via TaskCreate
# 3. Spawn analysts via Task tool
```

### Team Naming

Use descriptive slug: `incident-api-slowdown`, `incident-error-spike`, `incident-deploy-failure`.

## Agent Spawning

### Spawn Decision Matrix

| Condition | Action |
|-----------|--------|
| `--deploy-ref` provided | Spawn all 3 analysts, scope code-analyst to ref |
| No deploy context | Spawn code-analyst + log-analyst first, config-analyst on demand |
| Clearly code-related | log-analyst + code-analyst only |
| Infrastructure symptoms | All 3 analysts |

### Task Prompt Templates

**code-analyst**:
```
You are code-analyst in an incident investigation team.
Symptom: {symptom}
Since: {since}
Deploy ref: {deploy_ref}

Your scope:
- Analyze code changes around the incident timeframe
- Run: git diff, git log --since, git blame
- Report findings to incident-lead via SendMessage
- When other analysts share findings, narrow your investigation accordingly

State file: {repo_path}/.claude/incident-state.json
```

**log-analyst**:
```
You are log-analyst in an incident investigation team.
Symptom: {symptom}
Since: {since}

Your scope:
- Find and analyze relevant log files
- Identify error patterns and anomalies in the timeframe
- Perform time-series analysis of error rates/response times
- Report findings to incident-lead via SendMessage

State file: {repo_path}/.claude/incident-state.json
```

**config-analyst**:
```
You are config-analyst in an incident investigation team.
Symptom: {symptom}
Since: {since}

Your scope:
- Check config file changes (git diff on config paths)
- Verify environment variables
- Check infra config (Docker, K8s manifests, Terraform)
- Report findings to incident-lead via SendMessage
- If no changes found, report early and expect shutdown

State file: {repo_path}/.claude/incident-state.json
```

## Communication Patterns

### Finding Report Format

Analysts report findings to incident-lead using consistent format:

```
[FINDING] <severity>
Time: <when>
What: <description>
Evidence: <command output / file reference>
Suggested follow-up: <what other lines should check>
```

### Cross-Line Request Format

When one analyst needs another to check something:

```
[REQUEST] to <analyst-name>
Context: <what I found>
Please check: <specific request>
Priority: <high/medium/low>
```

### Leader Direction Format

When incident-lead adjusts investigation direction:

```
[DIRECTION] to <analyst-name>
Based on: <finding from other analyst>
New focus: <what to investigate>
Deprioritize: <what to stop investigating>
```

## Dynamic Adjustment

### Turn Budget Management

incident-lead monitors budget via `incident-state.sh check-budget`:

| Budget Used | Action |
|-------------|--------|
| < 50% | Normal operation |
| 50-80% | Start prioritizing, consider shutting down low-value lines |
| 80-90% | Wrap up, focus on consolidation |
| > 90% | Compile results immediately |

### Investigation Pivot Triggers

| Trigger | Leader Action |
|---------|--------------|
| Strong lead in one line | Redirect other analysts to confirm/support |
| Dead end in a line | Reassign analyst or shutdown |
| New symptom discovered | Create new task, assign to best-fit analyst |
| Conflicting findings | Request both analysts to cross-verify |

## Early Shutdown

### Shutdown Criteria

| Line | Early Shutdown When |
|------|-------------------|
| config-analyst | No config changes found, low infra probability |
| log-analyst | No relevant logs accessible, code cause confirmed |
| code-analyst | No recent code changes, clearly infra/config issue |

### Shutdown Procedure

```
1. incident-lead sends: SendMessage type="shutdown_request" to analyst
2. Analyst approves: SendMessage type="shutdown_response" approve=true
3. incident-lead updates: incident-state.sh update-line <line> shutdown
```

## Teardown

After Phase 4 (Resolution Plan) completes:

1. Send shutdown_request to all remaining analysts
2. Wait for confirmations
3. Update state: `incident-state.sh update-line <line> completed`
4. TeamDelete to clean up
