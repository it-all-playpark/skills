# Resolution Patterns

Templates for immediate, permanent, and prevention actions.

## Table of Contents

- [Immediate Actions](#immediate-actions)
- [Permanent Fixes](#permanent-fixes)
- [Prevention Measures](#prevention-measures)
- [Resolution Template](#resolution-template)

## Immediate Actions

### Rollback

```bash
# Revert specific commit
git revert <commit-hash> --no-edit
git push origin <branch>

# Rollback to known-good tag/ref
git checkout <good-ref> -- <affected-files>
git commit -m "revert: rollback affected files to <good-ref>"

# Full deploy rollback (if CI/CD supports it)
# Provide command appropriate to project's deployment system
```

**When to use**: Root cause is a specific code change, rollback is safe (no data migration dependencies).

### Feature Flag Disable

```bash
# Environment variable toggle
export FEATURE_X_ENABLED=false

# Config file toggle
sed -i 's/"feature_x": true/"feature_x": false/' config/features.json
```

**When to use**: Feature is behind a flag, disabling has no side effects.

### Hotfix

```bash
# Create hotfix branch
git checkout -b hotfix/<issue-description> <production-branch>

# Apply minimal fix
# ... edit specific file ...

# Fast-track merge
git push origin hotfix/<issue-description>
gh pr create --title "hotfix: <description>" --base <production-branch>
```

**When to use**: Rollback not possible (data migration already ran), minimal targeted fix is clear.

### Scale Up / Traffic Control

```bash
# Kubernetes scale
kubectl scale deployment/<name> --replicas=<N>

# Docker compose scale
docker compose up --scale <service>=<N> -d

# Rate limiting (nginx example)
# Add to location block: limit_req zone=one burst=10;
```

**When to use**: Resource exhaustion, traffic spike, buying time while fixing root cause.

### Database Emergency

```bash
# Recreate dropped index
CREATE INDEX CONCURRENTLY idx_name ON table_name (column1, column2);

# Kill long-running queries
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE duration > interval '5 minutes' AND state = 'active';

# Connection pool reset
# Restart application to reset connection pool
```

**When to use**: Database-related incidents (missing index, connection exhaustion, blocking queries).

## Permanent Fixes

### Code Fix PR

```markdown
## Fix: <description>

### Root Cause
<1-2 sentence explanation>

### Changes
- <file>: <what changed and why>

### Testing
- [ ] Unit tests added for regression
- [ ] Integration test covers the scenario
- [ ] Manual verification in staging

### Rollback Plan
<how to revert if this fix causes issues>
```

### Migration Strategy

For fixes requiring data migration:

1. **Pre-migration**: Backup affected data
2. **Migration script**: Idempotent, reversible
3. **Verification**: Query to confirm migration success
4. **Post-migration**: Clean up temporary data

### Architecture Improvement

For systemic issues:

1. **Problem statement**: Why current architecture failed
2. **Proposed change**: What to modify
3. **Impact analysis**: What other components are affected
4. **Migration path**: How to transition safely
5. **Timeline**: Estimated effort

## Prevention Measures

### CI Checks

| Check Type | Implementation | Prevents |
|-----------|----------------|----------|
| Schema diff review | CI step comparing DB migrations | Accidental index/constraint drops |
| Performance regression | Benchmark tests in CI | Slow query introduction |
| Config validation | Schema validation for config files | Invalid configuration deployment |
| Dependency audit | `npm audit` / `pip-audit` in CI | Known vulnerability deployment |
| Breaking change detection | API contract testing | Incompatible API changes |

### Monitoring and Alerts

| Metric | Threshold | Alert Channel |
|--------|-----------|---------------|
| Error rate | > 2x baseline for 5min | PagerDuty/Slack |
| Response time p95 | > 2x baseline for 5min | PagerDuty/Slack |
| CPU/Memory usage | > 80% for 10min | Slack |
| DB query time | > 1s for any query | Slack |
| Deploy events | Every deploy | Slack (info) |

### Process Improvements

| Process | Change | Rationale |
|---------|--------|-----------|
| Code review | Require DB migration review by DBA | Prevent accidental schema damage |
| Deploy process | Canary deployment for critical services | Detect issues before full rollout |
| Runbook | Create runbook for this incident type | Faster response next time |
| Postmortem | Schedule blameless postmortem | Organizational learning |

## Resolution Template

Use this template for the Resolution Plan section of the incident report:

```markdown
### Immediate Action
**Chosen approach**: [Rollback / Hotfix / Feature flag / Scale up]
**Command**:
\`\`\`bash
<exact command to execute>
\`\`\`
**Expected result**: <what should happen after execution>
**Verification**: <how to confirm the fix worked>

### Permanent Fix
**PR proposal**: <title>
**Changes required**:
1. <file/component>: <change description>
**Estimated effort**: <time estimate>
**Priority**: <P0/P1/P2>

### Prevention Measures
1. **CI**: <specific check to add>
2. **Monitoring**: <specific alert to configure>
3. **Process**: <specific process change>
```
