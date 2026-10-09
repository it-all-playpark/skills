# Environment & Profile ID Resolution

## Environment Variables

- `ZERNIO_API_KEY` — API key (global)
- `ZERNIO_PROFILE_ID` — Profile ID (optional, for project isolation)

## Prerequisites

zernio CLI は本 skill に同梱されない。利用者が別途 install し、PATH 上（または `~/.cargo/bin`）に置いておく必要がある。
skill 側は install を行わず、見つからなければエラー終了する。

## Binary Resolution

**CRITICAL**: `zernio` バイナリが PATH に無いと、subagent が外部API待ちで stall する。必ず最初に解決する。

Resolution order (最初に見つかった実行可能ファイルを使う):

1. `command -v zernio` → PATH 上に存在すればそれを使う
2. `~/.cargo/bin/zernio` → `cargo install` 経由のグローバルインストール
3. いずれも無ければ **エラー終了**: 「zernio CLI が見つかりません。別途 install してください」

### Resolver スニペット

```bash
resolve_zernio() {
  local candidates=(
    "$(command -v zernio 2>/dev/null)"
    "$HOME/.cargo/bin/zernio"
  )
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -x "$c" ]] && { echo "$c"; return 0; }
  done
  echo "Error: zernio binary not found. zernio CLI must be installed separately (put it on PATH or ~/.cargo/bin)." >&2
  return 1
}

ZERNIO_BIN=$(resolve_zernio) || exit 1
"$ZERNIO_BIN" --version
```

### 疎通確認

```bash
$ZERNIO_BIN --version
# zernio 0.1.0
```

## Profile ID Resolution

**CRITICAL**: Always resolve `--profile-id` before running any `zernio` command.

Resolution order:
1. User explicitly passes `--profile-id` → use as-is
2. Read `skill-config.json` → `zernio.profile_id` → pass as `--profile-id`
3. `ZERNIO_PROFILE_ID` env var → used automatically by CLI
4. None found → **WARN the user** that commands will affect ALL profiles

To read from skill-config.json:
```bash
PROFILE_ID=$(python3 -c "import json,os; [print(json.load(open(p)).get('zernio',{}).get('profile_id','')) for p in ['skill-config.json','.claude/skill-config.json'] if os.path.exists(p)][:1]" 2>/dev/null)
```

Then append `--profile-id $PROFILE_ID` to every `zernio` command if non-empty.
