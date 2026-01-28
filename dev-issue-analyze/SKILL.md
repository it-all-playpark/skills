---
name: dev-issue-analyze
description: |
  Fetch and analyze GitHub issue for implementation planning.
  Use when: understanding issue requirements, extracting acceptance criteria, planning implementation.
  Accepts args: <issue-number> [--depth minimal|standard|comprehensive]
---

# Issue Analyze

Fetch and parse GitHub issue for implementation planning.

## Execution

```bash
~/.claude/skills/dev-issue-analyze/scripts/analyze-issue.sh <issue-number> [--depth LEVEL]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--depth` | `standard` | Analysis depth |

## Depth Levels

| Level | Output |
|-------|--------|
| `minimal` | title, type, labels, state |
| `standard` | + AC, requirements, body preview |
| `comprehensive` | + affected files, components, breaking changes |

## Output

```json
{
  "issue_number": 123,
  "title": "...",
  "type": "feat|fix|refactor|docs",
  "state": "open|closed",
  "labels": ["bug", "enhancement"],
  "acceptance_criteria": ["- [ ] AC1", "- [ ] AC2"],
  "requirements": ["Req1", "Req2"],
  "affected_files": ["src/foo.ts"],
  "components": ["AuthService"],
  "breaking_changes": false
}
```

## Type Detection

| Label Pattern | Type |
|---------------|------|
| bug | fix |
| enhancement, feature | feat |
| refactor | refactor |
| doc | docs |
| (default) | feat |

## Examples

```bash
scripts/analyze-issue.sh 123
scripts/analyze-issue.sh 45 --depth minimal
scripts/analyze-issue.sh 67 --depth comprehensive
```
