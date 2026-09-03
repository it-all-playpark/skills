# Investigation Lines

Detailed procedures for each analysis line in incident investigation.

## Table of Contents

- [Code Line](#code-line)
- [Log Line](#log-line)
- [Config Line](#config-line)
- [Cross-Line Message Templates](#cross-line-message-templates)

## Code Line

**Analyst**: code-analyst
**Focus**: Code changes, deploy diffs, git blame

### Standard Procedure

1. **Recent changes**: `git log --since="$SINCE" --oneline --all`
2. **Deploy diff** (if `--deploy-ref`): `git diff $DEPLOY_REF..HEAD --stat`
3. **Detailed diff**: `git diff $DEPLOY_REF..HEAD -- <suspicious_paths>`
4. **Blame analysis**: `git blame -L <range> <file>` for suspicious code sections
5. **Impact analysis**: Trace changed functions to understand blast radius

### Key Commands

```bash
# Recent commits around incident time
git log --since="2h ago" --oneline --all --author-date-order

# Diff from last known good state
git diff $DEPLOY_REF..HEAD --stat
git diff $DEPLOY_REF..HEAD -- src/

# Specific file history
git log --follow -p -- <path>

# Who changed what
git blame -L 10,20 <file>

# Find commits touching specific function/pattern
git log -p --all -S '<search_term>' --since="$SINCE"
```

### What to Look For

| Signal | Severity | Example |
|--------|----------|---------|
| Index/constraint removal | High | DROP INDEX, ALTER TABLE |
| Query changes | High | Changed WHERE clauses, JOIN modifications |
| Connection pool changes | High | Pool size, timeout modifications |
| Error handling removal | Medium | Removed try/catch, changed error responses |
| New external API calls | Medium | Added HTTP calls, new service dependencies |
| Logging changes | Low | Removed/changed log statements |

### Reporting Findings

Report each significant change with:
- Commit hash and timestamp
- What changed (file, function, line range)
- Potential impact on reported symptom
- Confidence level (definite/probable/possible)

## Log Line

**Analyst**: log-analyst
**Focus**: Log files, error patterns, metrics

### Log File Discovery

Search in common locations:

```bash
# Application logs
find . -name "*.log" -mmin -120 2>/dev/null
ls -la logs/ log/ 2>/dev/null

# System logs (if accessible)
ls /var/log/syslog /var/log/messages 2>/dev/null

# Docker logs
docker ps --format '{{.Names}}' 2>/dev/null | while read c; do
  echo "=== $c ===" && docker logs --since "$SINCE" "$c" 2>&1 | tail -50
done

# journalctl (systemd)
journalctl --since "$SINCE" -u <service> 2>/dev/null
```

### Time-Series Analysis

```bash
# Error rate over time (per minute buckets)
grep -E "ERROR|FATAL|Exception" <logfile> | \
  awk '{print $1" "$2}' | \
  cut -d: -f1,2 | sort | uniq -c | sort -k2

# Response time analysis
grep "response_time" <logfile> | \
  awk -F'=' '{print $NF}' | \
  sort -n | awk '{a[NR]=$1} END {
    print "min:", a[1]
    print "max:", a[NR]
    print "median:", a[int(NR/2)]
    print "p95:", a[int(NR*0.95)]
    print "p99:", a[int(NR*0.99)]
  }'

# Error pattern extraction
grep -E "ERROR|FATAL|Exception" <logfile> | \
  sed 's/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}[T ][0-9:\.]*//g' | \
  sort | uniq -c | sort -rn | head -20
```

### What to Look For

| Signal | Severity | Example |
|--------|----------|---------|
| Error spike | Critical | 10x increase in error rate |
| Slow queries | Critical | Query time > 10x baseline |
| Connection errors | High | Connection refused, timeout |
| Memory warnings | High | OOM, GC pressure |
| New error types | Medium | Previously unseen error messages |
| Log gap | Medium | Missing logs in timeframe (crash?) |

### Reporting Findings

Report each anomaly with:
- Exact timestamps (first occurrence, peak, current)
- Error counts/rates (before vs after)
- Sample error messages (3-5 representative)
- Affected components/endpoints
- Correlation with other events

## Config Line

**Analyst**: config-analyst
**Focus**: Configuration files, environment variables, infrastructure changes

### Standard Procedure

1. **Config file changes**: `git diff $DEPLOY_REF..HEAD -- *.yml *.yaml *.json *.toml *.ini *.env* *.conf`
2. **Environment variables**: Check .env files, deployment configs
3. **Infra configs**: Docker, K8s, Terraform changes
4. **External service configs**: CDN, DNS, load balancer settings

### Key Commands

```bash
# Config file changes
git diff $DEPLOY_REF..HEAD -- '*.yml' '*.yaml' '*.json' '*.toml' '*.ini' '*.conf'
git diff $DEPLOY_REF..HEAD -- '**/config/**' '**/.env*' '**/settings.*'

# Docker changes
git diff $DEPLOY_REF..HEAD -- Dockerfile docker-compose* .dockerignore

# Kubernetes changes
git diff $DEPLOY_REF..HEAD -- k8s/ kubernetes/ '*.k8s.*' '**/*deployment*' '**/*service*'

# Terraform/infrastructure
git diff $DEPLOY_REF..HEAD -- '*.tf' '*.tfvars' terraform/

# Environment comparison
diff <(git show $DEPLOY_REF:.env 2>/dev/null || echo "") .env 2>/dev/null

# Check resource limits
grep -r "memory\|cpu\|limit\|request\|replica\|scale" k8s/ kubernetes/ 2>/dev/null
```

### What to Look For

| Signal | Severity | Example |
|--------|----------|---------|
| DB connection string change | Critical | Host, port, credentials |
| Resource limit decrease | High | Memory/CPU limits reduced |
| Replica count change | High | Scale down during peak |
| Timeout value change | Medium | Reduced connection/read timeouts |
| Feature flag change | Medium | Enabled untested feature |
| Log level change | Low | Debug -> Error (hiding info) |

### Reporting Findings

Report each change with:
- What config changed (file, key, before/after values)
- When changed (commit or deployment timestamp)
- Potential impact on reported symptom
- Whether change is reversible

## Cross-Line Message Templates

### log-analyst -> code-analyst

```
[REQUEST] to code-analyst
Context: Found {error_type} errors spiking at {time} in {log_source}.
  Error: "{sample_error_message}"
  Rate: {before_rate} -> {after_rate} per minute
Please check: Any code changes to {component/module} around {time}?
Priority: high
```

### code-analyst -> log-analyst

```
[REQUEST] to log-analyst
Context: Found commit {hash} ({time}) modifying {description}.
  Changes: {brief_diff_summary}
Please check: Any {specific_error/metric} patterns matching this change timing?
Priority: high
```

### config-analyst -> incident-lead

```
[FINDING] {severity}
Time: {change_time}
What: {config_key} changed from {old_value} to {new_value} in {file}
Evidence: git diff output showing the change
Suggested follow-up: {recommendation or "No config changes found, infra cause unlikely"}
```

### incident-lead -> analyst (redirect)

```
[DIRECTION] to {analyst}
Based on: {other_analyst} found {finding_summary}
New focus: Investigate {specific_area} around {timeframe}
Deprioritize: {area_to_stop}
```
