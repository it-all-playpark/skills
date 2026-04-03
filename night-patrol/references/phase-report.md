# Phase 4: Report - Detailed Steps

Update state: `phase: 4, status: "reporting"`

## Generate report

```bash
$SKILLS_DIR/night-patrol/scripts/generate-report.sh \
  --state .claude/night-patrol.json
```

Output: `claudedocs/night-patrol/$DATE.md`

## Telegram notification

Load `telegram_chat_id` from config. If set:

```
telegram reply --chat_id $CHAT_ID --text "Night Patrol 完了

${COMPLETED}件完了 / ${SKIPPED}件スキップ / ${FAILED}件失敗
${CUMULATIVE}行変更 (nightly/$DATE)

→ レポート: claudedocs/night-patrol/$DATE.md"
```

## Journal logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log night-patrol success \
  --context "scanned=$TOTAL,processed=$COMPLETED,skipped=$SKIPPED,failed=$FAILED"
```

Update state: `status: "done"`

## Journal Logging (success/failure)

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log night-patrol success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log night-patrol failure \
  --error-category <category> --error-msg "<message>"
```
