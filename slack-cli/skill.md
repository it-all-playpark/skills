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
Never run `slack` without `--token` — the CLI falls back to `SLACK_BOT_TOKEN` which may be a different bot.

### Steps (execute in order before every command)

1. Read `~/.claude/skills/slack-cli/workspaces.json`
2. Determine workspace: use `--workspace <name>` arg if provided, otherwise use `default` field
3. Look up the workspace entry and resolve `token_env` to get the env var name
4. Build the command with `--token "$<token_env>"` and optionally `--team-id <team_id>`

**Example:**
```bash
# workspaces.json has: default: "my-company", token_env: "SLACK_BOT_TOKEN_MY_COMPANY"
# Every command becomes:
slack --token "$SLACK_BOT_TOKEN_MY_COMPANY" list-channels
slack --token "$SLACK_BOT_TOKEN_MY_COMPANY" post-message --channel-id C123 --text "hello"
```

### Workspace Resolution Order

1. `--workspace <name>` argument → look up in `workspaces.json`
2. No `--workspace` but `default` is set → use that workspace
3. `workspaces.json` does not exist → fall back to `SLACK_BOT_TOKEN` (last resort only)

## Workspace Configuration

Workspaces are defined in `~/.claude/skills/slack-cli/workspaces.json` (copy from `workspaces.example.json`):

```json
{
  "default": "my-company",
  "workspaces": {
    "my-company": {
      "token_env": "SLACK_BOT_TOKEN_MY_COMPANY",
      "team_id": null,
      "description": "Main company workspace"
    },
    "client-project": {
      "token_env": "SLACK_BOT_TOKEN_CLIENT",
      "team_id": "T01ABC123",
      "description": "Client project workspace"
    }
  }
}
```

- `token_env`: Environment variable name holding the bot token (never store tokens directly)
- `team_id`: Optional Slack Team ID (for Enterprise Grid)
- `default`: Workspace name to use when `--workspace` is not specified. If `null`, falls back to `SLACK_BOT_TOKEN`
- `description`: Human-readable description for listing

### Setup

```bash
cp ~/.claude/skills/slack-cli/workspaces.example.json ~/.claude/skills/slack-cli/workspaces.json
# Edit workspaces.json with your actual workspace settings
```

### Listing Available Workspaces

When user asks "which workspaces are available" or similar, read `workspaces.json` and display the workspace names and descriptions.

## Global Options

All subcommands support these options:

| Option | Description |
|---|---|
| `--workspace <NAME>` | Select workspace from `workspaces.json` config |
| `--token <TOKEN>` | Override token (bypasses workspace config) |
| `--team-id <TEAM_ID>` | Slack Team ID (Enterprise Grid) |
| `-o, --output <FORMAT>` | `json` (default), `table`, `compact` |
| `-v, --verbose` | Enable verbose output |

## Subcommands Reference

**Note:** All examples below use `TOKEN` as shorthand. In practice, always pass `--token "$<resolved_token_env>"` as described in the Execution Protocol.

### 1. list-channels — List channels

```bash
slack --token "$TOKEN" list-channels [-o table] [--limit 100] [--cursor <CURSOR>]
```

- `--limit <N>`: Max channels to return (1-200, default: 100)
- `--cursor <CURSOR>`: Pagination cursor for next page
- Lists both public and private channels the bot has access to

### 2. post-message — Post a message

```bash
slack --token "$TOKEN" post-message --channel-id <CHANNEL_ID> --text "message"
```

- `--channel-id`: Required. Channel ID (e.g., C1234567890)
- `--text`: Required. Message text (supports mrkdwn)

### 3. reply-to-thread — Reply to a thread

```bash
slack --token "$TOKEN" reply-to-thread --channel-id <CHANNEL_ID> --thread-ts <TS> --text "reply"
```

- `--channel-id`: Required. Channel ID containing the thread
- `--thread-ts`: Required. Timestamp of parent message (e.g., 1234567890.123456)
- `--text`: Required. Reply text

### 4. add-reaction — Add emoji reaction

```bash
slack --token "$TOKEN" add-reaction --channel-id <CHANNEL_ID> --timestamp <TS> --reaction thumbsup
```

- `--channel-id`: Required. Channel ID
- `--timestamp`: Required. Message timestamp
- `--reaction`: Required. Emoji name without colons (e.g., `thumbsup`, `eyes`, `white_check_mark`)

### 5. get-channel-history — Read channel messages

```bash
slack --token "$TOKEN" get-channel-history --channel-id <CHANNEL_ID> [--limit 10] [-o table]
```

- `--channel-id`: Required. Channel ID
- `--limit <N>`: Messages to retrieve (1-200, default: 10)

### 6. get-thread-replies — Read thread replies

```bash
slack --token "$TOKEN" get-thread-replies --channel-id <CHANNEL_ID> --thread-ts <TS> [-o table]
```

- `--channel-id`: Required. Channel ID
- `--thread-ts`: Required. Parent message timestamp

### 7. get-users — List workspace users

```bash
slack --token "$TOKEN" get-users [--limit 100] [--cursor <CURSOR>] [-o table]
```

- `--limit <N>`: Max users to return (1-200, default: 100)
- `--cursor <CURSOR>`: Pagination cursor

### 8. get-user-profile — Get user profile

```bash
slack --token "$TOKEN" get-user-profile --user-id <USER_ID> [-o table]
```

- `--user-id`: Required. User ID (e.g., U1234567890)

## Workflow Patterns

### Read channel and respond

1. Read `workspaces.json` → resolve token (e.g. `$SLACK_BOT_TOKEN_PLAYPARK`)
2. `slack --token "$TOKEN" list-channels -o table` to find channel ID
3. `slack --token "$TOKEN" get-channel-history --channel-id <ID> --limit 20 -o json` to read messages
4. Identify the message timestamp from output
5. `slack --token "$TOKEN" post-message --channel-id <ID> --text "response"` or `slack --token "$TOKEN" reply-to-thread --channel-id <ID> --thread-ts <TS> --text "reply"`

### Find and message a user

1. Read `workspaces.json` → resolve token
2. `slack --token "$TOKEN" get-users -o table` to find user ID
3. `slack --token "$TOKEN" get-user-profile --user-id <ID>` for details

## Important Notes

- Channel IDs look like `C0XXXXXXXXX`, User IDs like `U0XXXXXXXXX`
- Message timestamps (ts) are in format `1234567890.123456` - these uniquely identify messages
- Always use `-o json` when you need to parse output programmatically; use `-o table` for user-facing display
- When posting messages, the text supports Slack mrkdwn format (bold: `*text*`, italic: `_text_`, code: `` `code` ``, link: `<url|text>`)
- Before posting or replying, always confirm the message content and target channel with the user
