# Journal Logging

On workflow completion or failure, log execution to skill-retrospective journal.

## Success (after Phase 8)

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE
```

## Failure (at any phase)

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --error-phase <phase> --worktree $WORKTREE
```

## Partial (completed with manual intervention)

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff partial \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --recovery "<what was done>" --recovery-turns $N --worktree $WORKTREE
```
