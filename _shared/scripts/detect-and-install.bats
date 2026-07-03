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
    rm -rf "$TMP_DIR"
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
