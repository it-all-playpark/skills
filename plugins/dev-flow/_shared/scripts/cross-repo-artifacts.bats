#!/usr/bin/env bats
# Tests for _shared/scripts/cross-repo-artifacts.sh
#
# Strategy: mktemp -d で隔離した2つの git repo（worktree 役 / 外部 repo 役）と
# 1つの非 git ディレクトリを用意し、各シナリオでスクリプトの JSON 出力を検証する。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/cross-repo-artifacts.sh"

    # worktree 役の repo
    WT="$(mktemp -d)"
    git -C "$WT" init -q
    git -C "$WT" config user.email t@t
    git -C "$WT" config user.name t
    printf 'wt file\n' > "$WT/wt-file.txt"
    git -C "$WT" add -A
    git -C "$WT" commit -q -m "wt base"

    # 外部 repo 役
    EXT="$(mktemp -d)"
    git -C "$EXT" init -q
    git -C "$EXT" config user.email t@t
    git -C "$EXT" config user.name t
    printf 'ext existing\n' > "$EXT/existing.txt"
    git -C "$EXT" add -A
    git -C "$EXT" commit -q -m "ext base"

    # 非 git な plain ディレクトリ
    PLAIN="$(mktemp -d)"
    printf 'plain file\n' > "$PLAIN/plain.txt"
}

teardown() {
    rm -rf "$WT" "$EXT" "$PLAIN"
}

# ---------------------------------------------------------------------------
# 1. 外部 repo の既存ファイルを変更 -> found=1, exists=true, dirty=true
# ---------------------------------------------------------------------------
@test "external repo existing file modified -> found=1, dirty=true" {
    printf 'ext existing modified\n' > "$EXT/existing.txt"

    # macOS では /tmp が /private/tmp のシンボリックリンクのため、git が解決する
    # 物理パスと mktemp -d が返す論理パスが食い違い得る。repo_root の期待値は
    # 実際に git が解決する toplevel を都度取得して比較する（symlink 差異を吸収）。
    expected_repo_root="$(git -C "$EXT" rev-parse --show-toplevel)"

    run bash "$SCRIPT" "$WT" "$EXT/existing.txt"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    printf '%s\n' "$output" | jq -e '.ok == true' >/dev/null
    printf '%s\n' "$output" | jq -e '.found == 1' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == true' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].dirty == true' >/dev/null
    printf '%s\n' "$output" | jq -e ".artifacts[0].repo_root == \"$expected_repo_root\"" >/dev/null
}

# ---------------------------------------------------------------------------
# 2. 外部 repo に untracked 新規ファイル -> found=1
# ---------------------------------------------------------------------------
@test "external repo untracked new file -> found=1" {
    printf 'brand new\n' > "$EXT/new-file.txt"

    run bash "$SCRIPT" "$WT" "$EXT/new-file.txt"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.found == 1' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == true' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].dirty == true' >/dev/null
}

# ---------------------------------------------------------------------------
# 3. 変更なしの既存ファイル -> exists=true, dirty=false, found=0
# ---------------------------------------------------------------------------
@test "external repo unmodified existing file -> exists=true, dirty=false, found=0" {
    run bash "$SCRIPT" "$WT" "$EXT/existing.txt"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.found == 0' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == true' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].dirty == false' >/dev/null
}

# ---------------------------------------------------------------------------
# 4. 不存在パス -> exists=false, found=0
# ---------------------------------------------------------------------------
@test "nonexistent path -> exists=false, found=0" {
    run bash "$SCRIPT" "$WT" "$EXT/does-not-exist.txt"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.found == 0' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == false' >/dev/null
}

# ---------------------------------------------------------------------------
# 5. worktree 配下のパス -> 除外され exists=false, found=0
# ---------------------------------------------------------------------------
@test "path under worktree -> excluded as exists=false, found=0" {
    printf 'wt file modified\n' > "$WT/wt-file.txt"

    run bash "$SCRIPT" "$WT" "$WT/wt-file.txt"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.found == 0' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == false' >/dev/null
}

# ---------------------------------------------------------------------------
# 6. 非 git ディレクトリのファイル -> repo_root 空、found に数えない
# ---------------------------------------------------------------------------
@test "file in non-git directory -> repo_root empty, found=0" {
    run bash "$SCRIPT" "$WT" "$PLAIN/plain.txt"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.found == 0' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == true' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].dirty == false' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].repo_root == ""' >/dev/null
}

# ---------------------------------------------------------------------------
# 7. 相対パス -> スキップ (exists=false, found=0)
# ---------------------------------------------------------------------------
@test "relative path -> skipped as exists=false, found=0" {
    run bash "$SCRIPT" "$WT" "relative/path.txt"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.found == 0' >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == false' >/dev/null
}

# ---------------------------------------------------------------------------
# 8. 引数不足 -> exit 1, stdout に JSON なし
# ---------------------------------------------------------------------------
@test "missing arguments -> non-zero exit, no stdout JSON" {
    run bash "$SCRIPT"
    [ "$status" -ne 0 ]
    [ -z "$output" ] || ! printf '%s' "$output" | jq -e . >/dev/null 2>&1
}

@test "missing candidate paths -> non-zero exit, no stdout JSON" {
    run bash "$SCRIPT" "$WT"
    [ "$status" -ne 0 ]
}

@test "nonexistent worktree path -> non-zero exit" {
    run bash "$SCRIPT" "/no/such/worktree/dir" "$EXT/existing.txt"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# 9. 複数候補・出力が jq でパース可能な 1 行 JSON
# ---------------------------------------------------------------------------
@test "multiple candidates -> single-line parseable JSON, correct aggregate found count" {
    printf 'ext existing modified again\n' > "$EXT/existing.txt"
    printf 'another new\n' > "$EXT/new2.txt"

    run bash "$SCRIPT" "$WT" "$EXT/existing.txt" "$EXT/new2.txt" "$EXT/does-not-exist.txt" "relative.txt"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    printf '%s\n' "$output" | jq -e . >/dev/null
    printf '%s\n' "$output" | jq -e '.artifacts | length == 4' >/dev/null
    printf '%s\n' "$output" | jq -e '.found == 2' >/dev/null
}

# ---------------------------------------------------------------------------
# 10. ~/ 先頭パスの展開 (HOME 配下の非 git ファイルで exists=true になることを確認)
# ---------------------------------------------------------------------------
@test "tilde-prefixed path is expanded relative to HOME" {
    # 実 $HOME への書き込みは sandbox で禁止されているため、HOME env var を
    # 差し替えて検証する（スクリプトは $HOME を参照して ~/ を展開する契約）。
    FAKE_HOME="$(mktemp -d)"
    printf 'home file\n' > "$FAKE_HOME/f.txt"

    run env HOME="$FAKE_HOME" bash "$SCRIPT" "$WT" "~/f.txt"
    rm -rf "$FAKE_HOME"

    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.artifacts[0].exists == true' >/dev/null
}
