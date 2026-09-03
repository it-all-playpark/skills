# Integration Points

## With session-save

At session end, check for unanalyzed journal entries:
```
If new failure entries exist since last retrospective:
  → Run lightweight analysis (patterns only, no proposals)
  → Report: "N件の新規失敗パターンを検出。/skill-retrospective で詳細分析できます"
```

## With existing skills

Add journal logging to skill completion points (1-line addition):

```bash
# At end of dev-kickoff (after Phase 6 or on failure)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff $OUTCOME ...

# At end of pr-iterate (after LGTM or max iterations)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-iterate $OUTCOME ...
```
