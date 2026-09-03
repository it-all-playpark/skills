# Analysis Domains Reference

Common reference for think-analyze and think-deep skills.

## Domain Overview

| Domain | Focus Areas |
|--------|-------------|
| quality | Code organization, maintainability, technical debt, patterns |
| security | Vulnerabilities, injection risks, auth issues, data exposure |
| performance | Speed, memory, scalability, bottlenecks, complexity |
| architecture | Structure, dependencies, coupling, cohesion, patterns |
| accessibility | WCAG compliance, user experience |
| testing | Coverage, edge cases, validation |

## Quality Analysis

| Metric | Description |
|--------|-------------|
| Complexity | Cyclomatic complexity, nesting depth |
| Maintainability | Readability, documentation, naming |
| Duplication | DRY violations, copy-paste code |
| Patterns | SOLID adherence, design patterns |
| Technical Debt | TODOs, workarounds, deprecated usage |

## Security Analysis

| Check | Description |
|-------|-------------|
| Injection | SQL, XSS, command injection risks |
| Auth | Authentication/authorization flaws |
| Data | Sensitive data exposure, logging |
| Dependencies | Known vulnerabilities in deps |
| Config | Hardcoded secrets, insecure defaults |

## Performance Analysis

| Metric | Description |
|--------|-------------|
| Complexity | O(n) analysis, algorithm efficiency |
| Memory | Leaks, excessive allocations |
| I/O | Database queries, network calls |
| Caching | Missing or ineffective caching |
| Concurrency | Race conditions, blocking ops |

## Architecture Analysis

| Aspect | Description |
|--------|-------------|
| Structure | Layer separation, module boundaries |
| Dependencies | Coupling, circular dependencies |
| Patterns | Consistency, appropriate patterns |
| Scalability | Growth potential, bottlenecks |
| Testability | Test coverage, mockability |

## Severity Levels

| Level | Description | Action |
|-------|-------------|--------|
| Critical | Security risk, data loss | Fix immediately |
| High | Major bug, performance | Fix soon |
| Medium | Quality issue | Plan fix |
| Low | Minor improvement | Consider |
