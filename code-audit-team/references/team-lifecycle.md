# Agent Team Lifecycle Patterns

Shared patterns for Agent Team coordination.

## Table of Contents

1. [Lifecycle Overview](#lifecycle-overview)
2. [Team Setup](#team-setup)
3. [Task Assignment](#task-assignment)
4. [Coordination](#coordination)
5. [Cost Control](#cost-control)
6. [Shutdown](#shutdown)
7. [Recovery](#recovery)

## Lifecycle Overview

```
TeamCreate → TaskCreate → Spawn agents → Assign tasks
  → Coordinate (SendMessage) → Collect results
  → Shutdown agents → TeamDelete
```

## Team Setup

1. **TeamCreate**: Create team with descriptive name
2. **TaskCreate**: Define tasks for each agent with clear scope
3. **Spawn**: Use Task tool with `team_name` and `name` to create agents
4. **Assign**: Use TaskUpdate with `owner` to assign tasks

```
TeamCreate: team_name="code-audit", description="Multi-perspective code audit"
TaskCreate: "Audit security of src/auth/" (for sec-auditor)
TaskCreate: "Audit performance of src/auth/" (for perf-auditor)
TaskCreate: "Audit architecture of src/auth/" (for arch-auditor)
```

## Task Assignment

- Assign tasks via TaskUpdate with `owner` parameter
- Each auditor checks TaskList on startup to find assigned work
- Use task dependencies (blockedBy) for ordered execution
- Mark tasks completed via TaskUpdate when done

## Coordination

### Direct Messages (SendMessage type: "message")
- Cross-domain queries between auditors
- Status updates to audit-lead
- Finding verification requests

### Broadcasts (SendMessage type: "broadcast")
- Reserve for critical issues only (expensive: N messages for N agents)
- Example: "Critical vulnerability found, all auditors pause and verify scope"

### Task-Based Coordination
- Use TaskList/TaskUpdate for status tracking
- Create new tasks for follow-up investigations
- Block tasks that depend on other findings

## Cost Control

### Turn Budgeting
- Total budget: `--max-turns` (default 40)
- Reserve ~25% for audit-lead (scope + synthesis + recommend)
- Distribute remaining ~75% equally among auditors
- Example with 40 turns, 3 auditors: ~10 lead + ~10 per auditor

### Early Termination
- If findings plateau (no new findings in 3+ turns), wrap up
- If critical finding impacts all domains, refocus team
- audit-lead monitors progress and can redirect resources

### Agent Idle Management
- Idle state is normal between turns
- Do not treat idle notifications as errors
- Send new work via SendMessage to wake idle agents

## Shutdown

Orderly shutdown sequence:

1. audit-lead collects all findings (Phase 3)
2. audit-lead generates report (Phase 4)
3. SendMessage type="shutdown_request" to each auditor
4. Wait for shutdown_response from each
5. TeamDelete to clean up resources

### Graceful Shutdown Template

```
For each auditor:
  SendMessage: type="shutdown_request", recipient="<name>",
    content="Audit complete, shutting down team"

After all agents confirm:
  TeamDelete
```

## Recovery

### Communication Failure
- Fall back to audit-state.json for finding persistence
- Each auditor writes findings independently
- audit-lead reads state file for synthesis

### Agent Crash
- Check audit-state.json for partial findings
- Re-spawn agent if turn budget allows
- Otherwise proceed with available findings

### Turn Budget Exceeded
- Generate report from current findings
- Note incomplete areas in report
- Flag unaudited files/modules
