# Workspace Configuration

Workspaces are defined in `workspaces.json` in the slack-cli skill directory (copy from `workspaces.example.json` in the same directory):

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

## Field Descriptions

- `token_env`: Environment variable name holding the bot token (never store tokens directly)
- `team_id`: Optional Slack Team ID (for Enterprise Grid)
- `default`: Workspace name to use when `--workspace` is not specified. If `null`, falls back to `SLACK_BOT_TOKEN`
- `description`: Human-readable description for listing

## Setup

```bash
# Run in the slack-cli skill directory (where this file's parent skill.md lives)
cp workspaces.example.json workspaces.json
# Edit workspaces.json with your actual workspace settings
```

## Listing Available Workspaces

When user asks "which workspaces are available" or similar, read `workspaces.json` and display the workspace names and descriptions.
