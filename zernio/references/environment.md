# Environment & Profile ID Resolution

## Environment Variables

- `ZERNIO_API_KEY` — API key (global)
- `ZERNIO_PROFILE_ID` — Profile ID (optional, for project isolation)

## Profile ID Resolution

**CRITICAL**: Always resolve `--profile-id` before running any `zernio` command.

Resolution order:
1. User explicitly passes `--profile-id` → use as-is
2. Read `.claude/skill-config.json` → `zernio.profile_id` → pass as `--profile-id`
3. `ZERNIO_PROFILE_ID` env var → used automatically by CLI
4. None found → **WARN the user** that commands will affect ALL profiles

To read from skill-config.json:
```bash
PROFILE_ID=$(python3 -c "import json; print(json.load(open('.claude/skill-config.json')).get('zernio',{}).get('profile_id',''))" 2>/dev/null)
```

Then append `--profile-id $PROFILE_ID` to every `zernio` command if non-empty.
