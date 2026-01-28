---
name: think-analyze
description: |
  Comprehensive code analysis across quality, security, performance, and architecture domains.
  Use when: (1) code review needed, (2) quality assessment, (3) security audit,
  (4) keywords: analyze, review, assess, audit, evaluate, inspect
  Accepts args: [target] [--focus DOMAIN] [--scope file|module|project] [--report]
---

# think-analyze

Multi-domain code analysis for quality, security, performance, and architecture.

## Usage

```
/sc:analyze [target] [--focus DOMAIN] [--scope file|module|project] [--report]
```

| Arg | Description |
|-----|-------------|
| target | File, directory, or component to analyze |
| --focus | Domain: quality, security, performance, architecture, all |
| --scope | Analysis boundary: file, module, project |
| --report | Generate detailed report in claudedocs/ |

## Analysis Domains

| Domain | Focus |
|--------|-------|
| quality | Organization, maintainability, debt |
| security | Vulnerabilities, auth, data exposure |
| performance | Speed, memory, scalability |
| architecture | Structure, dependencies, patterns |
| all | Comprehensive across all domains |

See `~/.claude/skills/_lib/analysis-domains.md` for detailed criteria per domain.

## Workflow

1. **Scope** → Identify analysis boundaries
2. **Scan** → Systematic code examination
3. **Evaluate** → Apply domain-specific criteria
4. **Report** → Structured findings with recommendations

## Output Format

```markdown
## 🔍 Analysis: [Target]

### Summary
| Domain | Score | Issues |
|--------|-------|--------|
| Quality | A-F | count |
| Security | A-F | count |
| Performance | A-F | count |
| Architecture | A-F | count |

### Critical Issues
1. [Issue]: [Location] - [Impact]

### Recommendations
| Priority | Action | Impact |
|----------|--------|--------|
| High | ... | ... |
| Medium | ... | ... |

### Details
[Domain-specific findings]
```

## Severity Levels

| Level | Description | Action |
|-------|-------------|--------|
| 🔴 Critical | Security risk, data loss | Fix immediately |
| 🟠 High | Major bug, performance | Fix soon |
| 🟡 Medium | Quality issue | Plan fix |
| 🟢 Low | Minor improvement | Consider |

## Examples

```
/sc:analyze src/auth/ --focus security
→ Security-focused analysis of authentication code

/sc:analyze . --scope project --report
→ Full project analysis with report saved to claudedocs/

/sc:analyze lib/utils.ts --focus quality
→ Quality analysis of single file

/sc:analyze --focus performance --scope module
→ Performance analysis of current module
```

## Tool Integration

| Domain | Primary Tools |
|--------|--------------|
| Quality | Grep, Read, native analysis |
| Security | Grep (pattern matching), Read |
| Performance | Read, Bash (profiling) |
| Architecture | Glob, Grep, Task/Explore |
