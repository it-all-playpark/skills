---
name: late-sync
description: |
  Synchronize Late API scheduled posts with local post/blog/*.json files.
  Use when: (1) blog dates rearranged and Late posts are stale,
  (2) keywords like "Late同期", "sync Late", "SNS同期", "予約 同期".
  Accepts args: [--from YYYY-MM-DD] [--execute] [--json]
user-invocable: true
argument-hint: [--from YYYY-MM-DD] [--execute]
---

# Late Sync

Synchronize Late API scheduled posts with local `post/blog/*.json` files.
One-way sync: **Local JSON → Late API** (local is source of truth).

## Usage

```
/late-sync [--from YYYY-MM-DD] [--execute] [--json] [--verbose]
```

| Argument | Description |
|----------|-------------|
| `--from, -f DATE` | Start date for sync (default: tomorrow) |
| `--execute` | Actually perform DELETE/CREATE (default: dry-run) |
| `--json` | Output results as JSON |
| `-v, --verbose` | Show detailed matching info |

## Examples

### Preview changes (dry-run, default)
```
/late-sync
```

### Sync from a specific date
```
/late-sync --from 2026-04-01
```

### Execute sync (DELETE orphaned + CREATE missing)
```
/late-sync --execute
```

### Verbose dry-run for debugging
```
/late-sync --verbose
```

### JSON output for scripting
```
/late-sync --json
```

## Sync Algorithm

1. **Fetch** scheduled posts from Late API (`dateFrom` filter)
2. **Load** local `post/blog/*.json` files (matching `--from` date)
3. **Generate matching keys**: `"YYYY-MM-DDTHH:MM|{platform}"`
4. **Diff**:
   - **Orphaned**: In Late but not local → DELETE
   - **Missing**: In local but not Late → CREATE
   - **Changed**: Key matches but content differs → DELETE + CREATE
   - **Matched**: Key + content match → skip
5. **Display** summary
6. If `--execute`, perform changes (500ms interval, rate-limit aware)

## Output Format

```
=== Late Sync ===
From: 2026-03-09
Local: 45 files → 42 posts (2026-03-09~)
Late:  38 scheduled (2026-03-09~)

🗑  Orphaned (DELETE from Late): 2
  2026-03-12 09:00 [linkedin] ID:abc123
  2026-03-15 07:30 [twitter]  ID:def456

📝 Missing (CREATE to Late): 3
  2026-03-18 07:30 [twitter]  ← rocket-rust-api-server.json
  2026-03-18 08:30 [linkedin] ← rocket-rust-api-server.json

🔄 Changed (DELETE + CREATE): 1
  2026-03-20 07:30 [twitter]  ID:ghi789 ← updated-article.json

✅ Matched: 34

Mode: DRY RUN (pass --execute to apply)
```

## Safety

- **Dry-run by default** — no changes without `--execute`
- Only affects `scheduled` posts (published posts are immutable in Late API)
- DELETE 404 is treated as warning (already deleted externally)
- Rate limited: 500ms between API calls + 429 retry

## Setup

Uses the same `.env` as sns-schedule-post:
- `$SKILLS_DIR/sns-schedule-post/.env`
- Requires `LATE_API_KEY`

## Config

Project-level `.claude/skill-config.json`:

```json
{
  "late-sync": {
    "timezone": "Asia/Tokyo",
    "post_dir": "post/blog",
    "profile_id": "your_late_profile_id"
  }
}
```

### Profile Isolation

`profile_id` is **strongly recommended** to avoid affecting other projects' posts.
Without it, all Late profiles are synced and orphaned posts from other projects may be deleted.

Get your profile ID via Late API: `GET /v1/profiles`

## Execution

The skill runs via:

```bash
npx tsx ~/.claude/skills/late-sync/scripts/sync.ts [OPTIONS]
```

Run from the project root directory (where `post/blog/` exists).
