---
name: code-audit-team
description: |
  Multi-perspective code audit using Agent Team with security, performance, and architecture specialists.
  Cross-domain findings through inter-agent communication.
  Use when: (1) comprehensive pre-release audit, (2) security + performance + architecture review needed,
  (3) large-scale refactoring assessment, (4) compliance or quality gate review,
  (5) keywords: audit, 監査, comprehensive review, 多角的レビュー, pre-release check, セキュリティ監査
  Accepts args: <target> [--scope file|module|project] [--focus DOMAIN,...] [--max-turns N] [--report]
model: opus
effort: max
allowed-tools:
  - Task
  - Skill
  - Bash(~/.claude/skills/code-audit-team/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
---

# Code Audit Team

Multi-perspective code audit with security, performance, and architecture specialists.
Cross-domain findings through inter-agent communication.

## Usage

```
/code-audit-team <target> [--scope file|module|project] [--focus DOMAIN,...] [--max-turns N] [--report]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `<target>` | required | File, directory, or component to audit |
| `--scope` | `module` | Audit boundary: file, module, project |
| `--focus` | `all` | Domains: security,performance,architecture (comma-separated) |
| `--max-turns` | `40` | Team-wide turn limit |
| `--report` | false | Save report to claudedocs/ |

## Workflow

```
Phase 1: Scope     → audit-lead defines boundaries and assigns auditors
Phase 2: Audit     → parallel specialist audits + cross-domain communication
Phase 3: Synthesize → collect, deduplicate, correlate findings
Phase 4: Recommend  → prioritized action plan
```

## Phase 1: Scope Definition (audit-lead)

1. Identify target files/modules
2. Estimate scale (file count, line count)
3. Determine team composition from `--focus`
4. Create TaskList with auditor assignments

### Team Composition

| Role | Name | Agent Type | Domain |
|------|------|-----------|--------|
| Leader | `audit-lead` | general-purpose | Scope, synthesis, action plan |
| Security | `sec-auditor` | Explore | Vulnerabilities, auth, data protection |
| Performance | `perf-auditor` | Explore | Bottlenecks, memory, scalability |
| Architecture | `arch-auditor` | Explore | Structure, dependencies, patterns, cohesion |

When `--focus` restricts domains, only spawn required auditors.

### Team Setup

```bash
# Initialize audit state
$SKILLS_DIR/code-audit-team/scripts/audit-state.sh init \
  --target "$TARGET" --scope "$SCOPE" --focus "$FOCUS"
```

Then use TeamCreate, TaskCreate, and spawn auditors via Task tool.

## Phase 2: Parallel Audit

Each auditor:
1. Read assigned files using Read/Grep tools
2. Apply domain-specific criteria from `$SKILLS_DIR/_lib/analysis-domains.md`
3. Record findings via `audit-state.sh add-finding`
4. Send cross-domain queries via SendMessage

### Cross-Domain Communication

See `references/cross-domain-patterns.md` for query templates.

Pattern: auditor discovers issue in their domain that may have implications in another domain.
They send a targeted question to the relevant auditor via SendMessage.
The receiving auditor investigates and records any new findings with `cross_domain: true`.

### Recording Findings

```bash
$SKILLS_DIR/code-audit-team/scripts/audit-state.sh add-finding \
  --domain security --severity critical \
  --location "src/auth/jwt.ts:45" \
  --title "JWT signature bypass" \
  --description "Token verification skipped for expired tokens" \
  --evidence "Line 45: if (token) return true; // TODO: verify"
```

## Phase 3: Synthesize (audit-lead)

1. Collect all findings: `audit-state.sh read`
2. Detect hotspots: `audit-state.sh detect-hotspots`
3. Deduplicate overlapping findings on same location
4. Correlate cross-domain findings
5. Score: `severity x cross_multiplier / fixability`

See `references/severity-scoring.md` for scoring criteria.

## Phase 4: Recommend (audit-lead)

1. Generate prioritized action plan
2. Identify Quick Wins (low effort, high impact)
3. Identify Strategic Fixes (architecture-level improvements)
4. If `--report`: save to `claudedocs/audit-report-{target}.md`
5. Shutdown team: SendMessage type=shutdown_request to each auditor
6. TeamDelete to clean up

## Output Format

```markdown
## Code Audit Report: [Target]

### Executive Summary
| Domain | Findings | Critical | High | Medium | Low |
|--------|----------|----------|------|--------|-----|

### Hotspots (Multi-domain Issues)
| Location | Domains | Combined Severity |
|----------|---------|-------------------|

### Critical & High Findings
#### [F1] Title (Domain: Severity)
- **Location**: file:line
- **Evidence**: [detail]
- **Cross-domain**: Related findings
- **Fix**: Recommended fix

### Action Plan
| Priority | Action | Domain | Impact | Effort |
|----------|--------|--------|--------|--------|

### Quick Wins
[Low-effort, high-impact fixes]

### Strategic Recommendations
[Architecture-level improvements]
```

## State Management

State persisted in `$CWD/.claude/audit-state.json`.

```bash
# Initialize
audit-state.sh init --target <target> --scope <scope> --focus <focus>

# Add finding
audit-state.sh add-finding --domain <domain> --severity <sev> \
  --location <loc> --title <title> --description <desc> --evidence <ev>

# Add cross-domain reference
audit-state.sh add-cross-ref --finding <id> --ref <other-id>

# Detect hotspots (same location, multiple domains)
audit-state.sh detect-hotspots

# Read current state
audit-state.sh read
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Auditor scope drift | audit-lead corrects via SendMessage |
| max-turns reached | Generate report from current findings |
| Domain findings overflow | audit-lead redistributes turns |
| Team communication error | File-based state recovery |

## References

- [Cross-Domain Patterns](references/cross-domain-patterns.md) - Inter-auditor query templates
- [Severity Scoring](references/severity-scoring.md) - Priority scoring criteria
- [Team Lifecycle](references/team-lifecycle.md) - Agent Team management patterns

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log code-audit-team success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log code-audit-team failure \
  --error-category <category> --error-msg "<message>"
```

