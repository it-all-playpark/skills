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

## Source field

All journal entries carry a `source` field indicating how the entry was written:

| Value | Written by | How |
|-------|-----------|-----|
| `"skill"` | Skill workflow | `journal.sh log` (explicit call from skill) |
| `"hook"` | PostToolUseFailure hook | `journal.sh hook-capture` (automatic capture on tool failure) |

**Migration compatibility**: Entries that predate this field may have an absent `source` key **or** a legacy `"hook-capture"` value (written by the old `cmd_hook_capture` implementation). Both are handled by all consumers using inclusive semantics: `(.source // "skill") == "skill"` to select skill entries, and `(.source // "skill") != "skill"` to select non-skill (hook) entries. This treats absent-source as `"skill"` and correctly excludes legacy `"hook-capture"` entries from skill statistics. No backfill is required.

**Aggregation default**: `dev-flow-doctor` and other stats/query consumers exclude `source == "hook"` entries by default, to avoid inflating skill-authored failure counts with hook-captured tool failures.

### query/stats filter examples

```bash
# Query last 7 days, skill-authored entries only
journal.sh query --since 7d --source skill

# Stats for skill-authored entries only
journal.sh stats --source skill

# Query hook-captured entries (PostToolUseFailure)
journal.sh query --since 7d --source hook
```

`--source` accepts `skill` or `hook`. Specifying `--source skill` includes entries where the field is absent (migration compatibility). Omitting `--source` returns all entries.

## Write guarantees

Each journal entry is written atomically:

1. The JSON payload is written to a temporary file `$JOURNAL_DIR/.tmp.XXXXXX` (created via `mktemp`).
2. The file is renamed (`mv`) to its final name: `YYYY-MM-DD-HH-MM-SS-<skill>-<pid>.json`.

The PID suffix (`<pid>`) prevents filename collisions when two entries are written within the same second. Because the `*.json` glob only matches final names, partial writes are never exposed to readers.

Schema reference: [../schemas/journal-entry.schema.json](../schemas/journal-entry.schema.json)
