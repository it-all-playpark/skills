# Agent Team Lifecycle Patterns

Common patterns for Agent Team coordination in bug-hunt.

## Team Setup

```
TeamCreate → TaskCreate (hypotheses) → Spawn teammates → Assign → Coordinate → Shutdown → TeamDelete
```

### 1. Create Team

```
TeamCreate: team_name="bug-hunt-{issue}", description="Bug investigation for {target}"
```

### 2. Create Tasks

Create one TaskCreate per hypothesis. Include:
- Subject: hypothesis description (imperative form)
- Description: verification steps, expected evidence, files to check
- ActiveForm: "Investigating {hypothesis summary}"

### 3. Spawn Teammates

```
Task(Explore): investigator-1, team_name="bug-hunt-{issue}"
Task(Explore): investigator-2, team_name="bug-hunt-{issue}"  # only if needed
Task: fix-proposer, team_name="bug-hunt-{issue}"             # only after root cause
```

### 4. Assign Tasks

Use TaskUpdate with `owner` to assign hypothesis tasks to investigators.

### 5. Coordinate

- Receive investigator messages automatically (no polling needed)
- Use SendMessage for redirection instructions
- Update TaskList as hypotheses are added/rejected
- Monitor budget via hunt-state.sh check-budget

### 6. Shutdown

```
SendMessage: type="shutdown_request", recipient="investigator-1"
SendMessage: type="shutdown_request", recipient="investigator-2"
SendMessage: type="shutdown_request", recipient="fix-proposer"
```

Wait for shutdown_response from each. Then call TeamDelete.

## Cost Control

### Turn Budget

- Track turns per investigator via state file
- Each investigator message = 1 turn
- hunt-lead management messages not counted
- Check budget before assigning new work

### Scaling Rules

| Hypotheses | Investigators | Rationale |
|-----------|---------------|-----------|
| 1-2 | 1 | Simple bug, sequential sufficient |
| 3-5 | 2 | Parallel investigation beneficial |
| 5+ | 2 | Cap at 2, prioritize hypotheses |

### Early Termination

- Root cause confirmed with high confidence -> skip remaining hypotheses
- Budget at 80% -> converge with best available evidence
- All active hypotheses rejected, no new leads -> request user input

## Idle State Handling

Teammates go idle after every turn. This is normal.

- Idle does NOT mean done or unavailable
- Sending a message wakes idle teammates
- Do not react to idle notifications unless assigning new work

## Error Recovery

### Communication Failure

If SendMessage fails:
1. Check state file for last known status
2. Retry message once
3. If still failing, read team config to verify member exists
4. Reconstruct team if necessary

### State File Recovery

If state file corrupted:
1. Create new state from TaskList current status
2. Mark in-progress hypotheses as needs-review
3. Continue investigation

## Investigator Instructions Template

When spawning investigators, include this context:

```
You are investigating a bug. Your role:
1. Read your assigned task from TaskList
2. Follow the verification steps in the task description
3. Use Grep, Read, Bash to collect evidence
4. SendMessage your findings to hunt-lead with:
   - What you found (with file:line references)
   - Whether the hypothesis is confirmed/rejected/needs more info
   - Any new hypotheses that emerged
5. Wait for hunt-lead to assign your next task
```

## Fix Proposer Instructions Template

```
You are proposing a fix for a confirmed root cause. Your role:
1. Read the root cause and evidence chain from hunt-lead's message
2. Create a minimal fix that addresses the root cause
3. Create regression test cases
4. Check for similar patterns in the codebase
5. SendMessage your proposal to hunt-lead for review
```
