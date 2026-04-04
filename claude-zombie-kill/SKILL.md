---
name: claude-zombie-kill
description: >
  Detect and kill zombie Claude Code sessions (stale processes from previous sessions).
  Use when: (1) user asks about zombie/stale Claude processes,
  (2) keywords like "ゾンビ", "zombie", "stale session", "プロセス掃除", "残ってない？",
  (3) user reports slow system or too many Claude processes running,
  (4) session cleanup or process management for Claude Code CLI.
  Accepts args: [--force]
effort: low
---

# Claude Zombie Kill

Detect and kill zombie Claude Code CLI sessions from previous days.

## Workflow

1. Run `scripts/zombie-kill.sh` from skill directory
2. Script lists processes started before today as zombies
3. User confirms before kill (unless `--force`)
4. Stubborn processes get SIGKILL after 1s grace period

## Usage

```bash
# Interactive (confirm before kill)
bash SKILL_DIR/scripts/zombie-kill.sh

# Auto-kill without confirmation
bash SKILL_DIR/scripts/zombie-kill.sh --force
```

## Detection Logic

- **macOS `ps` format**: Today's processes show `HH:MMAM/PM` (e.g. `10:15AM`), older ones show `DayHHAM` (e.g. `Thu06AM`)
- **Zombie criteria**: Any `claude` or `claude-code` process NOT matching today's time format
- **Excluded**: `chrome-native-host` (Claude Desktop extension, not CLI)

## Kill Strategy

1. `SIGTERM` first (graceful)
2. Wait 1 second
3. `SIGKILL` for any survivors

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log claude-zombie-kill success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log claude-zombie-kill failure \
  --error-category <category> --error-msg "<message>"
```
