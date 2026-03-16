# Journal Entry Format

Skills log via helper script:

```bash
# Log success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log <skill> success \
  [--issue N] [--duration-turns N] [--context "key=value"]

# Log failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log <skill> failure \
  --error-category <cat> --error-msg "message" \
  [--error-phase "phase_name"] \
  [--recovery "what was done"] [--recovery-turns N]

# Log partial (completed with issues)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log <skill> partial \
  --error-category <cat> --error-msg "message" \
  --recovery "workaround applied" --recovery-turns N
```

## Error Categories

`lint` | `test` | `build` | `runtime` | `config` | `env` | `merge` | `type-check`

See [error-categories.md](error-categories.md) for full classification guide.
