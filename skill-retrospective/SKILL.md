---
name: skill-retrospective
description: |
  Self-improving meta-skill that learns from skill execution failures.
  Analyzes journal entries, detects recurring patterns, and generates concrete skill modification proposals.
  Use when: (1) session end to review failures, (2) explicit retrospective request,
  (3) keywords: retrospective, 振り返り, learn, 改善, skill improvement, failure analysis
  Accepts args: [--since <date>] [--skill <name>] [--apply] [--dry-run]
allowed-tools:
  - Bash
  - Skill
---

# skill-retrospective

Analyze skill execution history, detect failure patterns, and generate self-improvement proposals.

## Usage

```
/skill-retrospective [--since <date>] [--skill <name>] [--apply] [--dry-run]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--since` | last retrospective | ISO date or relative (e.g., `7d`, `2w`) |
| `--skill` | all | Filter to specific skill name |
| `--apply` | false | Auto-apply approved proposals |
| `--dry-run` | false | Show proposals without prompting |

## Workflow

```
1. COLLECT   → Read journal entries from ~/.claude/journal/
2. FILTER    → Select entries since last retrospective (or --since)
3. ANALYZE   → Detect failure patterns across 5 axes
4. CORRELATE → Read affected skill .md files, identify gaps
5. PROPOSE   → Generate concrete modification proposals
6. PRESENT   → Show proposals to user for approval
7. APPLY     → Edit skill files, commit changes (if approved)
8. PERSIST   → Save retrospective summary to memory file
```

See [references/workflow-phases.md](references/workflow-phases.md) for detailed phase descriptions, commands, and output formats.

## Analysis Axes

| Axis | What it detects |
|------|-----------------|
| **Recurring failures** | Same error 2+ times across entries |
| **Instruction gaps** | Skill .md lacks handling for observed error |
| **Guard deficiency** | Pre-condition not checked |
| **Workflow inefficiency** | Recovery turns consistently > 2 |
| **Environment issues** | Errors in env/config category |

Each pattern is scored by: `frequency × impact × preventability`

See [references/analysis-patterns.md](references/analysis-patterns.md) for detection algorithms.

## Proposal Output

For each detected pattern, a proposal is generated:

```
### Pattern #{N}: {title} ({count}回発生)
影響スキル / エラーカテゴリ / 根本原因 / 再発リスク / スコア
修正案 (diff format)
アクション: 承認 / 修正して承認 / 却下
```

User approves, modifies, or rejects each proposal interactively.

## Examples

```bash
# Full retrospective (all entries since last run)
/skill-retrospective

# Last 7 days only
/skill-retrospective --since 7d

# Focus on dev-kickoff failures
/skill-retrospective --skill dev-kickoff

# Preview without prompting
/skill-retrospective --dry-run

# Auto-apply all proposals (trust mode)
/skill-retrospective --apply
```

## References

- [Workflow Phases](references/workflow-phases.md) - Detailed phase descriptions (collect → persist)
- [Journal Format](references/journal-format.md) - journal.sh usage and log commands
- [Integration Guide](references/integration-guide.md) - session-save and skill integration
- [Error Categories](references/error-categories.md) - Error classification taxonomy
- [Analysis Patterns](references/analysis-patterns.md) - Pattern detection algorithms
