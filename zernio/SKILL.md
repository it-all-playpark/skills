---
name: zernio
description: |
  Zernio CLI wrapper for SNS scheduling and sync.
  Use when: (1) scheduling or posting to SNS platforms (X, LinkedIn, Facebook, Google Business, Threads, Bluesky, Instagram, YouTube, TikTok),
  (2) syncing local JSON files with Zernio API,
  (3) after /sns-announce or /video-announce to schedule generated posts,
  (4) keywords: "SNS投稿", "予約投稿", "schedule post", "Zernio同期", "sync Zernio", "SNS同期".
  Accepts args: post|sync [OPTIONS]
user-invocable: true
argument-hint: post|sync [OPTIONS]
---

# Zernio

> **CRITICAL**: zernio CLI を直接呼び出さないでください。必ず `/zernio` スキル経由で実行してください。
> スキルが `skill-config.json` から `sync_dirs`, `profile_id` を自動解決します。
> 直接CLIを叩くと `sync_dirs` が欠落し、**投稿が削除される危険**があります。

Zernio CLI wrapper for SNS scheduling and sync.

## Usage

```
/zernio post [OPTIONS]
/zernio sync [OPTIONS]
```

## Workflow

```
0. Resolve binary path (zernio CLI の場所を確定)
1. Resolve Profile ID
2. Execute command (post or sync)
3. Verify result
```

## Step 0: Resolve Binary Path

**CRITICAL**: `zernio` が PATH に無いまま subagent から呼ぶと、外部 API 待ちで stall する。必ず最初に解決する。

優先順:
1. `command -v zernio` (PATH)
2. `~/.cargo/bin/zernio` (cargo install)
3. `~/ghq/github.com/playpark-llc/zernio-cli/target/release/zernio` (source build)

いずれも無ければ `cargo install --path ~/ghq/github.com/playpark-llc/zernio-cli` を促してエラー終了。

詳細・resolver スニペット・install 手順: [Environment](references/environment.md)

## Step 1: Resolve Profile ID

**CRITICAL**: Always resolve `--profile-id` before running any `zernio` command.

Resolution order:
1. User explicitly passes `--profile-id` → use as-is
2. Read `skill-config.json` → `zernio.profile_id` → pass as `--profile-id`
3. `ZERNIO_PROFILE_ID` env var → used automatically by CLI
4. None found → **WARN the user** that commands will affect ALL profiles

```bash
PROFILE_ID=$(python3 -c "
import json, os
for p in ['skill-config.json', '.claude/skill-config.json']:
    if os.path.exists(p):
        v = json.load(open(p)).get('zernio',{}).get('profile_id','')
        if v: print(v); break
" 2>/dev/null)
```

Then append `--profile-id $PROFILE_ID` to every `zernio` command if non-empty.

## Step 2: Execute Command

### post — Create or schedule SNS posts

```bash
# Batch from JSON (most common — sns-announce / video-announce output)
zernio post --json posts.json [--dry-run]

# Text post
zernio post --text "投稿内容" --platforms x,linkedin --schedule "2026-03-20 09:00"

# Media post
zernio post --media video.mp4 --caption "Caption" --platforms instagram --media-type reel
```

Full options: [CLI Reference](references/cli-reference.md)

### sync — Sync local JSON with Zernio API

**IMPORTANT**: Before running sync, resolve `sync_dirs` from config:

```bash
SYNC_DIRS=$(python3 -c "
import json, os
for p in ['skill-config.json', '.claude/skill-config.json']:
    if os.path.exists(p):
        dirs = json.load(open(p)).get('zernio',{}).get('sync_dirs',[])
        if dirs:
            print(' '.join(f'--dir {d}' for d in dirs))
            break
" 2>/dev/null)
```

If `sync_dirs` is configured, ALWAYS use ALL directories. Never pass fewer `--dir` values than `sync_dirs` specifies — missing directories cause their posts to be **DELETED** from the API.

```bash
# When sync_dirs is configured (e.g. ["./post/blog", "./post/bip"]):
zernio sync $SYNC_DIRS --from 2026-04-01 --execute

# Single dir example (only when sync_dirs is not configured):
zernio sync --dir ./post/blog --from 2026-04-01 --execute
```

Full options: [CLI Reference](references/cli-reference.md)

## Execution

This skill calls `zernio` CLI directly. Do NOT use the old TypeScript scripts.

### Pipeline Example

```bash
# Generate posts → schedule
/sns-announce content/blog/2026-03-20-article.mdx --format json
zernio post --json post/2026-03-20-article.json

# Sync after date changes (uses sync_dirs from config)
zernio sync $SYNC_DIRS --from 2026-03-20 --execute
```

## References

- [CLI Reference](references/cli-reference.md) - 全コマンド・オプション詳細
- [Platforms](references/platforms.md) - プラットフォームエイリアス一覧
- [Environment](references/environment.md) - 環境変数・Profile ID Resolution 詳細

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log zernio success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log zernio failure \
  --error-category <category> --error-msg "<message>"
```
