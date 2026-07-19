#!/usr/bin/env bats
# Tests for _shared/scripts/detect-and-install.sh
#
# Strategy: mktemp -d で一時ディレクトリを作成し、依存ファイルの有無で --lockfile-only の
# 挙動を検証する。実 install を避けるため全ケース --dry-run を併用する (issue #291 / F3)。

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/detect-and-install.sh"
    TMP_DIR="$(mktemp -d)"
}

teardown() {
    chmod 644 "$TMP_DIR/package-lock.json" 2>/dev/null || true
    rm -rf "$TMP_DIR"
}

# Mirrors the sha256sum -> shasum -a 256 fallback used by hash_lockfile() in
# detect-and-install.sh, so tests can compute the expected cache value
# (issue #375).
compute_hash() {
    local f="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$f" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$f" | awk '{print $1}'
    else
        return 1
    fi
}

@test "(a) package.json のみ (lock なし) + --lockfile-only --dry-run では node の result が含まれない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | map(select(.ecosystem == "node")) | length == 0'
    printf '%s\n' "$output" | jq -e '.status == "no_dependencies"'
}

@test "(b) package.json + package-lock.json + --lockfile-only --dry-run は npm ci の dry_run result を含む" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run" and .command == "npm ci")'
}

@test "(c) pnpm-lock.yaml + --lockfile-only --dry-run は pm 'pnpm' を検出する" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    : > "$TMP_DIR/pnpm-lock.yaml"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm")'
}

@test "(d) requirements.txt のみ + --lockfile-only --dry-run では python の result が含まれない" {
    echo 'requests==2.0.0' > "$TMP_DIR/requirements.txt"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | map(select(.ecosystem == "python")) | length == 0'
}

@test "(e) go.mod のみ (go.sum なし) + --lockfile-only --dry-run では go の result が含まれない" {
    echo 'module example.com/foo' > "$TMP_DIR/go.mod"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | map(select(.ecosystem == "go")) | length == 0'
}

@test "(e-2) go.mod + go.sum + --lockfile-only --dry-run では go の result が含まれる" {
    echo 'module example.com/foo' > "$TMP_DIR/go.mod"
    : > "$TMP_DIR/go.sum"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "go")'
}

@test "(f) フラグなしの既存挙動は不変: package.json のみ + --dry-run は pm 'npm-no-lock' / command 'npm install'" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm-no-lock" and .command == "npm install")'
}

@test "(g) lockfile hash がキャッシュと一致 + node_modules ありは cache_hit で skip する (issue #375)" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    printf 'npm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit")'
}

@test "(h) lockfile hash がキャッシュと不一致は fail-open で再 install パス (dry_run) を取る" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    printf 'npm:deadbeef\n' > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit") | not'
}

@test "(i) cache 情報なし (node_modules ありだが cache file なし) は fail-open で install パス (dry_run) を取る" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "already_installed") | not'
}

@test "(j) lockfile 読み取り不能 (hash取得失敗) は fail-open で install パス (dry_run) を取る" {
    [[ "${EUID:-0}" -eq 0 ]] && skip "root では chmod 000 が読み取り制限にならない"
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    printf 'npm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    chmod 000 "$TMP_DIR/package-lock.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    chmod 644 "$TMP_DIR/package-lock.json"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
}

@test "(k) install 成功時に cache を保存し、2回目は cache_hit で stub npm を再実行しない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    STUB_LOG="$TMP_DIR/npm-invocations.log"
    : > "$STUB_LOG"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
echo "\$@" >> "$STUB_LOG"
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
    [ -f "$TMP_DIR/.devflow-tmp/deps-lockfile-hash" ]
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    [ "$(cat "$TMP_DIR/.devflow-tmp/deps-lockfile-hash")" = "npm:$hash" ]

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit")'
    [ "$(wc -l < "$STUB_LOG" | tr -d ' ')" -eq 1 ]
}

@test "(l) pnpm でも lockfile hash 一致で cache_hit する" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    : > "$TMP_DIR/pnpm-lock.yaml"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/pnpm-lock.yaml")
    printf 'pnpm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "cache_hit")'
}

# ============================================================================
# Cross-worktree shared cache (issue #387).
#
# The shared cache root is overridable via DEVFLOW_DEPS_CACHE_DIR so tests
# stay hermetic (never touch $HOME). Layout: <root>/<pm>-<sha256(lockfile)>/
# node_modules. The mechanism only activates when --lockfile-only is passed
# (dev-flow's fixed Setup contract flag); without it, the shared cache is
# never touched. New status string: "cross_worktree_restore".
# ============================================================================

@test "(m) fresh worktree + 共有キャッシュに hash 一致エントリがあれば --lockfile-only で cross_worktree_restore する" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    mkdir -p "$SHARED/npm-$hash/node_modules"
    : > "$SHARED/npm-$hash/node_modules/.marker"

    run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cross_worktree_restore")'
    [ -f "$TMP_DIR/node_modules/.marker" ]
    [ -f "$TMP_DIR/.devflow-tmp/deps-lockfile-hash" ]
    [ "$(cat "$TMP_DIR/.devflow-tmp/deps-lockfile-hash")" = "npm:$hash" ]
}

@test "(n) --lockfile-only 無しでは共有キャッシュに一致エントリがあっても使わない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    mkdir -p "$SHARED/npm-$hash/node_modules"
    : > "$SHARED/npm-$hash/node_modules/.marker"

    run "$SCRIPT" --path "$TMP_DIR" --dry-run
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
}

@test "(o) lockfile hash 不一致では共有キャッシュを使わず通常 install パスにフォールバックする" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    mkdir -p "$SHARED/npm-deadbeef/node_modules"

    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
}

@test "(p) node_modules ありの既存 cache_hit 経路は共有キャッシュがあっても cross_worktree_restore にならない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    printf 'npm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    mkdir -p "$SHARED/npm-$hash/node_modules"

    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit")'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
}

@test "(q) install 成功後に共有キャッシュへ populate される" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
    [ -d "$SHARED/npm-$hash/node_modules" ]
}

@test "(r) populate の dest 衝突は crash しない（並行 run 想定）" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    # stub npm がインストールと同時に「別プロセスが先に populate 済み」の状態を
    # 模擬する (populate 時点での dest 衝突を再現するため、restore 判定が走る
    # install 開始前ではなく install 実行中に共有キャッシュを出現させる)。
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
mkdir -p "$SHARED/npm-$hash/node_modules"
: > "$SHARED/npm-$hash/node_modules/.marker"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
    [ -f "$SHARED/npm-$hash/node_modules/.marker" ]
}

@test "(s) 共有キャッシュ書き込み不能時は fail-open で installed を返す" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"
    # DEVFLOW_DEPS_CACHE_DIR を通常ファイルに向け、mkdir -p を構造的に失敗させる
    : > "$TMP_DIR/not-a-dir"
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/not-a-dir"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
}

@test "(t) 共有キャッシュ復元コピー失敗時は fail-open で通常 install パスに落ちる" {
    [[ "${EUID:-0}" -eq 0 ]] && skip "root では chmod 000 が読み取り制限にならない"
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"

    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    mkdir -p "$SHARED/npm-$hash/node_modules"
    : > "$SHARED/npm-$hash/node_modules/.marker"
    # 復元元ディレクトリを読み取り不能にし、cp によるコピーを失敗させる
    chmod 000 "$SHARED/npm-$hash/node_modules"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    chmod 755 "$SHARED/npm-$hash/node_modules"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
}
