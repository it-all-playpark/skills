---
name: slack-cli
description: >-
  Interact with Slack workspace via CLI - list channels, read/post messages, reply to threads, react, list users.
  Use when: (1) user wants to read or send Slack messages,
  (2) keywords like "slack", "チャンネル", "スレッド", "メッセージ送信", "リアクション",
  (3) user asks about channel history or thread replies,
  (4) user wants to list Slack channels or users.
  Accepts args: [--workspace <name>] <subcommand> [options]
---

# Slack CLI Skill

Interact with Slack workspace using the `slack` CLI tool (v0.1.0).

## Prerequisites

- `slack` CLI installed (located at `~/.local/share/mise/installs/rust/1.94.0/bin/slack`)
- Workspace configuration in `~/.claude/skills/slack-cli/workspaces.json`
- Optional: `SLACK_TEAM_ID` for Enterprise Grid workspaces

## Execution Protocol (MUST follow for every command)

**Every `slack` CLI invocation MUST include `--token`.**
Never run `slack` without `--token` -- the CLI falls back to `SLACK_BOT_TOKEN` which may be a different bot.

### Steps (execute in order before every command)

1. Read `~/.claude/skills/slack-cli/workspaces.json`
2. Determine workspace: use `--workspace <name>` arg if provided, otherwise use `default` field
3. Look up the workspace entry and resolve `token_env` to get the env var name
4. Build the command with `--token "$<token_env>"` and optionally `--team-id <team_id>`

**Example:**
```bash
# workspaces.json has: default: "my-company", token_env: "SLACK_BOT_TOKEN_MY_COMPANY"
slack --token "$SLACK_BOT_TOKEN_MY_COMPANY" list-channels
slack --token "$SLACK_BOT_TOKEN_MY_COMPANY" post-message --channel-id C123 --text "hello"
```

### Workspace Resolution Order

1. `--workspace <name>` argument -> look up in `workspaces.json`
2. No `--workspace` but `default` is set -> use that workspace
3. `workspaces.json` does not exist -> fall back to `SLACK_BOT_TOKEN` (last resort only)

## Workspace Configuration

Config file: `~/.claude/skills/slack-cli/workspaces.json`. Details: [Config Schema & Setup](references/config.md)

## Global Options

All subcommands support these options:

| Option | Description |
|---|---|
| `--workspace <NAME>` | Select workspace from `workspaces.json` config |
| `--token <TOKEN>` | Override token (bypasses workspace config) |
| `--team-id <TEAM_ID>` | Slack Team ID (Enterprise Grid) |
| `-o, --output <FORMAT>` | `json` (default), `table`, `compact` |
| `-v, --verbose` | Enable verbose output |

## Subcommands

| Subcommand | Purpose | Key Args |
|---|---|---|
| `list-channels` | List channels | `[--limit] [--cursor]` |
| `post-message` | Post a message | `--channel-id --text` |
| `reply-to-thread` | Reply to a thread | `--channel-id --thread-ts --text` |
| `add-reaction` | Add emoji reaction | `--channel-id --timestamp --reaction` |
| `get-channel-history` | Read channel messages | `--channel-id [--limit]` |
| `get-thread-replies` | Read thread replies | `--channel-id --thread-ts` |
| `get-users` | List workspace users | `[--limit] [--cursor]` |
| `get-user-profile` | Get user profile | `--user-id` |

Details: [Subcommand Specifications](references/subcommands.md)

## Workflow Patterns

Common patterns: resolve workspace -> find channel/user -> read/post messages.

Details: [Workflow Patterns](references/workflow-patterns.md)

## Scripts

### `scripts/resolve-workspace.sh`

Deterministic workspace token resolution. Run before any Slack CLI command.

```bash
# Resolve default workspace
./scripts/resolve-workspace.sh
# Resolve specific workspace
./scripts/resolve-workspace.sh --workspace my-company
```

Output: `{"workspace": "name", "token_env": "ENV_VAR_NAME", "team_id": "T01ABC123"|null, "token_set": true|false}`

The LLM handles all actual Slack operations; this script only resolves which token env var to use.

## Important Notes

- Channel IDs look like `C0XXXXXXXXX`, User IDs like `U0XXXXXXXXX`
- Message timestamps (ts) are in format `1234567890.123456` - these uniquely identify messages
- Always use `-o json` when you need to parse output programmatically; use `-o table` for user-facing display
- When posting messages, the text supports Slack mrkdwn format (bold: `*text*`, italic: `_text_`, code: `` `code` ``, link: `<url|text>`)
- Before posting or replying, always confirm the message content and target channel with the user

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log slack-cli success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log slack-cli failure \
  --error-category <category> --error-msg "<message>"
```
