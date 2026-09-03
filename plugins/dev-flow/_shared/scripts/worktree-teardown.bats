#!/usr/bin/env bats
# Tests for _shared/scripts/worktree-teardown.sh
#
# Strategy: 各テストは $BATS_TEST_TMPDIR 配下に隔離した tmp git repo + worktree
# fixture を作る。fixture repo は「.veridelta/ を含む .gitignore」と tracked な
# README.md を commit 済みとし、remove-blocked ケースは README.md の modify で
# 発火させる（gitignore 済みファイルは git worktree remove を block しないため）。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/worktree-teardown.sh"
}

make_repo() {
    # $1 = repo path
    local repo="$1"
    git init -q "$repo"
    git -C "$repo" config user.email t@t
    git -C "$repo" config user.name t
    printf '.veridelta/\n' > "$repo/.gitignore"
    printf '# readme\n' > "$repo/README.md"
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
}

# ---------------------------------------------------------------------------
# ケース1: 正常系(AC-1/AC-4 自動化版) — teardown 成功、worktree 消滅、
#          archive-root に .veridelta/runs/*.json の内容が読める
# ---------------------------------------------------------------------------
@test "archives before remove and worktree is removed cleanly" {
    REPO="$BATS_TEST_TMPDIR/repo1"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt1"
    git -C "$REPO" worktree add -q "$WT" -b wt1-branch

    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"a"}\n' > "$WT/.veridelta/runs/a.json"

    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive1"

    run bash "$SCRIPT" "$WT" --archive-root "$ARCHIVE_ROOT"
    [ "$status" -eq 0 ]
    [ ! -d "$WT" ]

    found="$(find "$ARCHIVE_ROOT" -name 'a.json' 2>/dev/null | head -n1)"
    [ -n "$found" ]
    grep -q '"run":"a"' "$found"
}

# ---------------------------------------------------------------------------
# ケース2: remove-blocked 系 — tracked ファイル(README.md)を modify すると
#          git worktree remove が fatal(exit 128 系)で fail するが、退避は
#          remove 実行より前に完了済み(順序保証の失敗系証明)
# ---------------------------------------------------------------------------
@test "remove blocked by modified tracked file still archives first" {
    REPO="$BATS_TEST_TMPDIR/repo2"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt2"
    git -C "$REPO" worktree add -q "$WT" -b wt2-branch

    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"b"}\n' > "$WT/.veridelta/runs/b.json"

    # tracked file modify -> blocks git worktree remove
    printf 'modified\n' >> "$WT/README.md"

    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive2"

    run bash "$SCRIPT" "$WT" --archive-root "$ARCHIVE_ROOT"
    [ "$status" -ne 0 ]
    [ -d "$WT" ]
    printf '%s\n' "$output" | grep -q '退避は完了済み'

    found="$(find "$ARCHIVE_ROOT" -name 'b.json' 2>/dev/null | head -n1)"
    [ -n "$found" ]
    grep -q '"run":"b"' "$found"

    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# ケース3: fail-open 系(AC-2) — archive-root への書込不可でも teardown は
#          worktree remove を続行して成功する
# ---------------------------------------------------------------------------
@test "archive failure is fail-open and worktree is still removed" {
    REPO="$BATS_TEST_TMPDIR/repo3"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt3"
    git -C "$REPO" worktree add -q "$WT" -b wt3-branch

    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"c"}\n' > "$WT/.veridelta/runs/c.json"

    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive3"
    mkdir -p "$ARCHIVE_ROOT"
    chmod 555 "$ARCHIVE_ROOT"

    LOG_FILE="$BATS_TEST_TMPDIR/logs/veridelta-archive.log"

    VDELTA_ARCHIVE_LOG="$LOG_FILE" run bash "$SCRIPT" "$WT" --archive-root "$ARCHIVE_ROOT"

    chmod 755 "$ARCHIVE_ROOT"

    [ "$status" -eq 0 ]
    [ ! -d "$WT" ]
    [ -f "$LOG_FILE" ]
    grep -q "veridelta-archive" "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# ケース4: veridelta-archive.sh 不在(スクリプト同梱ディレクトリから外した状態)
#          -> 警告を出して続行(fail-open)、remove は成功
# ---------------------------------------------------------------------------
@test "veridelta-archive.sh missing -> warns and continues (fail-open)" {
    ISOLATED_DIR="$BATS_TEST_TMPDIR/isolated-scripts"
    mkdir -p "$ISOLATED_DIR"
    cp "$SCRIPT" "$ISOLATED_DIR/worktree-teardown.sh"
    chmod +x "$ISOLATED_DIR/worktree-teardown.sh"

    REPO="$BATS_TEST_TMPDIR/repo4"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt4"
    git -C "$REPO" worktree add -q "$WT" -b wt4-branch

    run bash "$ISOLATED_DIR/worktree-teardown.sh" "$WT"
    [ "$status" -eq 0 ]
    [ ! -d "$WT" ]
    printf '%s\n' "$output" | grep -qi 'veridelta-archive.sh not found'
}

# ---------------------------------------------------------------------------
# 非 worktree パス -> exit 2
# ---------------------------------------------------------------------------
@test "non-worktree path -> error exit 2" {
    NOTWT="$BATS_TEST_TMPDIR/notwt"
    mkdir -p "$NOTWT"
    run bash "$SCRIPT" "$NOTWT"
    [ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# 引数不足 -> usage を stderr に出し exit 2
# ---------------------------------------------------------------------------
@test "missing arguments -> usage on stderr, exit 2" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
}
