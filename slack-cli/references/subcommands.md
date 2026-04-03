# Subcommands Reference

**Note:** All examples use `TOKEN` as shorthand. In practice, always pass `--token "$<resolved_token_env>"` as described in the Execution Protocol.

## 1. list-channels -- List channels

```bash
slack --token "$TOKEN" list-channels [-o table] [--limit 100] [--cursor <CURSOR>]
```

- `--limit <N>`: Max channels to return (1-200, default: 100)
- `--cursor <CURSOR>`: Pagination cursor for next page
- Lists both public and private channels the bot has access to

## 2. post-message -- Post a message

```bash
slack --token "$TOKEN" post-message --channel-id <CHANNEL_ID> --text "message"
```

- `--channel-id`: Required. Channel ID (e.g., C1234567890)
- `--text`: Required. Message text (supports mrkdwn)

## 3. reply-to-thread -- Reply to a thread

```bash
slack --token "$TOKEN" reply-to-thread --channel-id <CHANNEL_ID> --thread-ts <TS> --text "reply"
```

- `--channel-id`: Required. Channel ID containing the thread
- `--thread-ts`: Required. Timestamp of parent message (e.g., 1234567890.123456)
- `--text`: Required. Reply text

## 4. add-reaction -- Add emoji reaction

```bash
slack --token "$TOKEN" add-reaction --channel-id <CHANNEL_ID> --timestamp <TS> --reaction thumbsup
```

- `--channel-id`: Required. Channel ID
- `--timestamp`: Required. Message timestamp
- `--reaction`: Required. Emoji name without colons (e.g., `thumbsup`, `eyes`, `white_check_mark`)

## 5. get-channel-history -- Read channel messages

```bash
slack --token "$TOKEN" get-channel-history --channel-id <CHANNEL_ID> [--limit 10] [-o table]
```

- `--channel-id`: Required. Channel ID
- `--limit <N>`: Messages to retrieve (1-200, default: 10)

## 6. get-thread-replies -- Read thread replies

```bash
slack --token "$TOKEN" get-thread-replies --channel-id <CHANNEL_ID> --thread-ts <TS> [-o table]
```

- `--channel-id`: Required. Channel ID
- `--thread-ts`: Required. Parent message timestamp

## 7. get-users -- List workspace users

```bash
slack --token "$TOKEN" get-users [--limit 100] [--cursor <CURSOR>] [-o table]
```

- `--limit <N>`: Max users to return (1-200, default: 100)
- `--cursor <CURSOR>`: Pagination cursor

## 8. get-user-profile -- Get user profile

```bash
slack --token "$TOKEN" get-user-profile --user-id <USER_ID> [-o table]
```

- `--user-id`: Required. User ID (e.g., U1234567890)
