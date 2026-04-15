# Investigation & Audit Output Templates

Reusable prompt fragments for subagent dispatch in bug-hunt, code-audit-team, etc.

## Root Cause Investigation

### Process
1. **Reproduce**: Understand the failure (error message, stack trace, conditions)
2. **Hypothesize**: Form 2-3 candidate causes based on symptoms
3. **Gather evidence**: Read code paths, check git blame, grep for related patterns
4. **Eliminate**: Rule out hypotheses with evidence, narrow to root cause
5. **Verify**: Confirm the remaining hypothesis explains ALL symptoms

### Output Format
```
## Symptoms
- What was observed

## Hypotheses Tested
### H1: [description] — ❌ Eliminated
- Evidence: ...

### H2: [description] — ✅ Root Cause
- Evidence: `file:line` — ...
- Why this explains all symptoms: ...

## Root Cause
One paragraph summary

## Recommended Fix
Description of what to change (no code edits)
```

## Security Audit

### Scan Order
1. Hardcoded secrets, API keys, credentials in code and config
2. SQL/NoSQL injection, XSS, command injection
3. Authentication and authorization flaws
4. Insecure deserialization, SSRF
5. Dependency vulnerabilities (outdated packages)
6. Sensitive data exposure (logs, error messages)

### Output Format
```
## Security Findings

### [CRITICAL|HIGH|MEDIUM|LOW] Title
- **Location**: `file:line`
- **Issue**: What's wrong
- **Impact**: What an attacker could do
- **Remediation**: How to fix (description only)

## Summary
- Critical: N, High: N, Medium: N, Low: N
- Overall risk assessment
```
