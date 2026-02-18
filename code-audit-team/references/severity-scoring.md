# Severity Scoring Reference

Priority scoring criteria for audit findings.

## Table of Contents

1. [Single-Domain Severity](#single-domain-severity)
2. [Cross-Domain Multiplier](#cross-domain-multiplier)
3. [Fixability Scale](#fixability-scale)
4. [Priority Score Formula](#priority-score-formula)
5. [Priority Tiers](#priority-tiers)

## Single-Domain Severity

| Level | Score | Criteria |
|-------|-------|----------|
| Critical | 4 | Security breach risk, data loss, system crash |
| High | 3 | Major bug, significant performance degradation, auth bypass |
| Medium | 2 | Quality issue, moderate performance impact, code smell |
| Low | 1 | Minor improvement, style issue, optimization opportunity |

### Domain-Specific Severity Guides

**Security**:
- Critical: Injection, auth bypass, data exposure, RCE
- High: CSRF, insecure direct object reference, missing encryption
- Medium: Missing input validation, verbose error messages
- Low: Missing security headers, weak password policy

**Performance**:
- Critical: System hang, memory exhaustion, O(n^3+) in hot path
- High: N+1 queries, blocking I/O in request path, memory leaks
- Medium: Unnecessary allocations, missing indexes, suboptimal caching
- Low: Premature optimization opportunities, minor inefficiencies

**Architecture**:
- Critical: Circular dependencies causing deadlock, data corruption risk
- High: God class, tight coupling, missing abstraction layer
- Medium: Code duplication, inconsistent patterns, poor cohesion
- Low: Naming inconsistency, minor convention violations

## Cross-Domain Multiplier

Findings referenced by multiple domains indicate systemic issues.

| Domains Involved | Multiplier |
|-----------------|------------|
| 1 domain | 1.0x |
| 2 domains | 1.5x |
| 3 domains | 2.0x |

## Fixability Scale

Lower fixability score = easier to fix = higher priority.

| Level | Score | Criteria |
|-------|-------|----------|
| Easy | 0.3 | Single file change, clear fix, < 30 min |
| Medium | 0.6 | Multiple files, some design needed, < 2 hours |
| Hard | 1.0 | Architectural change, cross-cutting concern, > 2 hours |

## Priority Score Formula

```
priority = (severity_score x cross_domain_multiplier) / fixability_score
```

### Examples

| Finding | Severity | Domains | Fixability | Score |
|---------|----------|---------|------------|-------|
| SQL injection, single file | 4 (Critical) | 1 (1.0x) | Easy (0.3) | 13.3 |
| Auth scattered + inconsistent | 3 (High) | 2 (1.5x) | Hard (1.0) | 4.5 |
| N+1 query, simple fix | 3 (High) | 1 (1.0x) | Easy (0.3) | 10.0 |
| God class, perf + arch issue | 2 (Medium) | 2 (1.5x) | Hard (1.0) | 3.0 |

## Priority Tiers

| Tier | Score Range | Action |
|------|------------|--------|
| P0 - Immediate | >= 10.0 | Fix before release, blocks deployment |
| P1 - Urgent | 5.0 - 9.9 | Fix in current sprint |
| P2 - Planned | 2.0 - 4.9 | Schedule in backlog |
| P3 - Consider | < 2.0 | Address when convenient |
