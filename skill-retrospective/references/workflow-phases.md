# Workflow Phases (Detailed)

## Phase 1: Collect Journal Entries

Journal entries are stored at `~/.claude/journal/`:

```bash
# List entries
ls ~/.claude/journal/*.json | wc -l

# Read entries since date
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query \
  --since "2026-02-01" --skill dev-kickoff
```

## Phase 2: Filter

Filter criteria (applied in order):
1. `--since` date threshold (default: timestamp from last retrospective memory)
2. `--skill` name filter (optional)
3. Exclude already-analyzed entries (tracked in memory)

If no new entries exist since last retrospective, report "No new entries" and exit.

## Phase 3: Analyze Patterns

Run analysis across 5 axes:

| Axis | Detection | Example |
|------|-----------|---------|
| **Recurring failures** | Same error 2+ times across entries | node_modules missing 3x |
| **Instruction gaps** | Skill .md lacks handling for observed error | dev-kickoff-worker missing dev-env-setup invocation |
| **Guard deficiency** | Pre-condition not checked | No lockfile detection before install |
| **Workflow inefficiency** | Recovery turns consistently > 2 | validate→fix loop averaging 4 turns |
| **Environment issues** | Errors in env/config category | .env, deps, Docker not running |

See [analysis-patterns.md](analysis-patterns.md) for pattern detection details.

### Analysis Process

For each failure entry:
1. Categorize error by [error-categories](error-categories.md)
2. Check if same pattern exists in other entries (fuzzy match on error message + category)
3. Read the affected skill's SKILL.md
4. Identify whether the skill's instructions could have prevented the failure
5. Score pattern by: `frequency * impact * preventability`

## Phase 4: Correlate with Skill Files

For each detected pattern:

```bash
# Read the affected skill's SKILL.md
SKILL_PATH=$SKILLS_DIR/${SKILL_NAME}/SKILL.md

# Check if the skill already handles this case
grep -c "${ERROR_PATTERN}" "$SKILL_PATH"
```

Determine gap type:
- **Missing instruction**: Skill doesn't mention the prerequisite/step
- **Incomplete guard**: Skill mentions but doesn't enforce
- **Wrong assumption**: Skill assumes something that isn't always true

## Phase 5: Generate Proposals

Output format per pattern:

```markdown
### Pattern #{N}: {title} ({count}回発生)

**影響スキル**: {skill_name}
**エラーカテゴリ**: {category}
**根本原因**: {root_cause}
**再発リスク**: 高|中|低
**スコア**: {frequency} x {impact} x {preventability} = {score}

**修正案** ({skill_name}/SKILL.md):
\`\`\`diff
  ## Existing Section
  ...
+ ## New/Modified Section
+ Added instruction or guard
\`\`\`

**アクション**: [ ] 承認 / [ ] 修正して承認 / [ ] 却下
```

## Phase 6: Present to User

Use AskUserQuestion for each proposal:
- Option 1: 承認（そのまま適用）
- Option 2: 修正して承認（ユーザーが修正内容を指定）
- Option 3: 却下（この提案をスキップ）

## Phase 7: Apply Changes

For approved proposals:
1. Edit the target skill's SKILL.md using the proposed diff
2. If `--apply` flag: auto-commit with message `fix(skill-name): description`
3. If not: stage changes only, user commits manually

## Phase 8: Persist

Save retrospective summary to memvid via `memory-cli`:

```bash
TMPFILE=$(mktemp /tmp/retro-XXXXXX.md)
cat > "$TMPFILE" << EOF
## Skill Retrospective: {YYYY-MM-DD}

- **Date range**: {start} ~ {end}
- **Patterns detected**: {count}
- **Proposals**: {generated} generated / {accepted} accepted / {rejected} rejected
- **Skills modified**: {skill_list}
- **Last analyzed entry**: {timestamp}
EOF

memvid put ~/.claude/memory/global.mv2 --input "$TMPFILE" \
  --embedding \
  --title "Retrospective: {summary} {YYYY-MM}" \
  --tag type=retrospective \
  --uri "retrospective/{YYYY-MM-DD}/{slug}"

rip "$TMPFILE"
```

This memory enables:
- Next retrospective knows where to start (`--since`) via `memvid find --query "retrospective 最新"`)
- Historical trend tracking
- Duplicate pattern suppression
