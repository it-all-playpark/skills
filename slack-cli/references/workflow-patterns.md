# Workflow Patterns

## Read channel and respond

1. Read `workspaces.json` -> resolve token (e.g. `$SLACK_BOT_TOKEN_PLAYPARK`)
2. `slack --token "$TOKEN" list-channels -o table` to find channel ID
3. `slack --token "$TOKEN" get-channel-history --channel-id <ID> --limit 20 -o json` to read messages
4. Identify the message timestamp from output
5. `slack --token "$TOKEN" post-message --channel-id <ID> --text "response"` or `slack --token "$TOKEN" reply-to-thread --channel-id <ID> --thread-ts <TS> --text "reply"`

## Find and message a user

1. Read `workspaces.json` -> resolve token
2. `slack --token "$TOKEN" get-users -o table` to find user ID
3. `slack --token "$TOKEN" get-user-profile --user-id <ID>` for details
