# Environment & Profile ID Resolution

## Environment Variables

- `ZERNIO_API_KEY` — API key (global)
- `ZERNIO_PROFILE_ID` — Profile ID (optional, for project isolation)

## Binary Resolution

**CRITICAL**: `zernio` バイナリが PATH に無いと、subagent が外部API待ちで stall する。必ず最初に解決する。

Resolution order (最初に見つかった実行可能ファイルを使う):

1. `command -v zernio` → PATH 上に存在すればそれを使う
2. `~/.cargo/bin/zernio` → `cargo install` 経由のグローバルインストール
3. `~/ghq/github.com/playpark-llc/zernio-cli/target/release/zernio` → ソースリポジトリの release build
4. `~/ghq/github.com/playpark-llc/zernio-cli/target/debug/zernio` → debug build (release が無い場合の最後の手段)
5. いずれも無ければ **エラー終了**: 「`cargo install --path ~/ghq/github.com/playpark-llc/zernio-cli` を実行してください」

### Resolver スニペット

```bash
resolve_zernio() {
  local candidates=(
    "$(command -v zernio 2>/dev/null)"
    "$HOME/.cargo/bin/zernio"
    "$HOME/ghq/github.com/playpark-llc/zernio-cli/target/release/zernio"
    "$HOME/ghq/github.com/playpark-llc/zernio-cli/target/debug/zernio"
  )
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -x "$c" ]] && { echo "$c"; return 0; }
  done
  echo "Error: zernio binary not found. Install via: cargo install --path ~/ghq/github.com/playpark-llc/zernio-cli" >&2
  return 1
}

ZERNIO_BIN=$(resolve_zernio) || exit 1
"$ZERNIO_BIN" --version
```

### Install / Update

```bash
# 初回インストール
cd ~/ghq/github.com/playpark-llc/zernio-cli
cargo install --path .

# Update (リポジトリを pull した後)
cargo install --path . --force
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
