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
$SKILLS_DIR/dev-issue-analyze/scripts/analyze-issue.sh <issue-number> [--depth LEVEL]
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

## Tech Stack & Best Practice Context

After issue analysis, detect the project's tech stack and load relevant best practices
into context. This ensures implementation planning is informed by framework guidelines.

1. Run `$SKILLS_DIR/_lib/scripts/detect-stack.sh` to detect frameworks
2. For each detected skill in `rules_paths`, Read the corresponding SKILL.md
3. Keep loaded — downstream skills (dev-implement, dev-decompose) benefit from
   the best-practice context already present in the conversation

## Examples

```bash
scripts/analyze-issue.sh 123
scripts/analyze-issue.sh 45 --depth minimal
scripts/analyze-issue.sh 67 --depth comprehensive
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-issue-analyze success \
  --issue $ISSUE --duration-turns $TURNS

# On failure (issue not found, API error, etc.)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-issue-analyze failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```
