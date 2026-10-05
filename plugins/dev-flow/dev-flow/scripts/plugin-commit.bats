#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/plugin-commit.sh (issue #785)
#
# telemetry キー plugin_commit の給電元。cache mode（plugin root のディレクトリ名 = commit SHA 先頭 12 桁）
# と link mode（repo checkout の HEAD）の両方で 12 桁 hex を返し、決められなければ空出力 + exit 0
# （記録専用なので dev-flow を止めない）。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/plugin-commit.sh"

setup() {
    # fixture の外側にある repo（BATS_TEST_TMPDIR の祖先）を link mode として拾わせない
    export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
}

@test "cache mode: plugin root のディレクトリ名（12 桁 hex）をそのまま返す" {
    root="$BATS_TEST_TMPDIR/cache/playpark/dev-flow/1ef2e0ab6254"
    mkdir -p "$root/bin"
    run bash "$SCRIPT" "$root"
    [ "$status" -eq 0 ]
    [ "$output" = "1ef2e0ab6254" ]
}

@test "link mode: plugin root を含む checkout の HEAD 先頭 12 桁を返す" {
    repo="$BATS_TEST_TMPDIR/skills"
    git init -q -b main "$repo"
    git -C "$repo" config user.name "Test"
    git -C "$repo" config user.email "test@example.com"
    mkdir -p "$repo/plugins/dev-flow/bin"
    echo x >"$repo/plugins/dev-flow/bin/dev-flow-prerun"
    git -C "$repo" add .
    git -C "$repo" commit -q -m init
    expected="$(git -C "$repo" rev-parse HEAD)"
    run bash "$SCRIPT" "$repo/plugins/dev-flow"
    [ "$status" -eq 0 ]
    [ "$output" = "${expected:0:12}" ]
    [[ "$output" =~ ^[0-9a-f]{12}$ ]]
}

@test "取得失敗: git 管理外かつディレクトリ名が 12 桁 hex でない -> 空出力・exit 0" {
    root="$BATS_TEST_TMPDIR/cache/playpark/dev-flow/0.3.0"
    mkdir -p "$root"
    run bash "$SCRIPT" "$root"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "取得失敗: commit の無い repo -> 空出力・exit 0" {
    repo="$BATS_TEST_TMPDIR/empty-repo"
    git init -q -b main "$repo"
    mkdir -p "$repo/plugins/dev-flow"
    run bash "$SCRIPT" "$repo/plugins/dev-flow"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "取得失敗: plugin root が存在しない / 未指定 -> 空出力・exit 0" {
    run bash "$SCRIPT" "$BATS_TEST_TMPDIR/missing/1ef2e0ab6254"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}
