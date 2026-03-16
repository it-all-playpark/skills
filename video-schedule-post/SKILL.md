---
name: video-schedule-post
description: |
  DEPRECATED: Use /late-schedule-post instead.
  This skill forwards all arguments to late-schedule-post.
---

# Video Schedule Post (DEPRECATED)

> **This skill is deprecated.** Use [`/late-schedule-post`](../late-schedule-post/SKILL.md) instead.
>
> All arguments are forwarded to `late-schedule-post` as-is.

## Quick Redirect

```bash
# Instead of:
/video-schedule-post --json post/2026-03-12-promo-video.json

# Use:
/late-schedule-post --json post/2026-03-12-promo-video.json
```

```bash
# Instead of:
/video-schedule-post --media video.mp4 --caption "text" --type reel

# Use:
/late-schedule-post --media video.mp4 --caption "text" --type reel
```

All flags (`--json`, `--media`, `--caption`, `--type`, `--schedule`, `--dry-run`, etc.) work identically in `/late-schedule-post`.

## Legacy Reference

For the full original documentation (JSON format, platform-specific fields, implementation details, constraints, examples), see:

- [references/legacy-usage.md](references/legacy-usage.md)
