#!/usr/bin/env bats
# Tests for pr-iterate/scripts/ensure-committed.sh
#
# Strategy: build a real temporary git repo per test (setup) plus, for tests
# that exercise push behavior, a local bare repo used as `origin`. No gh/git
# stubs are needed here (unlike check-ci.bats) since ensure-committed.sh only
# shells out to plain `git`.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/ensure-committed.sh"

    WORK_DIR="$(mktemp -d)"
    REPO_DIR="$WORK_DIR/repo"
    mkdir -p "$REPO_DIR"
    cd "$REPO_DIR" || exit 1
    git init -q
    git config user.email "t@t"
    git config user.name "t"
    echo "hello" > file.txt
    git add file.txt
    git -c user.email=t@t -c user.name=t commit -q -m "init"
}

teardown() {
    cd "$SKILLS_REPO" || cd /
    rm -rf "$WORK_DIR"
}

# ---------------------------------------------------------------------------
# B1: clean repo --check-only -> dirty:false, files:0
# ---------------------------------------------------------------------------
@test "B1: clean repo --check-only -> dirty false, files 0" {
    run "$SCRIPT" --check-only
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.dirty')" = "false" ]
    [ "$(echo "$result" | jq -r '.files')" = "0" ]
}

# ---------------------------------------------------------------------------
# B2: tracked change (1) + untracked (1) --check-only -> dirty:true, files:2
# ---------------------------------------------------------------------------
@test "B2: tracked+untracked --check-only -> dirty true, files 2" {
    echo "modified" >> file.txt
    echo "new" > untracked.txt
    run "$SCRIPT" --check-only
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.dirty')" = "true" ]
    [ "$(echo "$result" | jq -r '.files')" = "2" ]
}

# ---------------------------------------------------------------------------
# B3: clean repo --pr 5 --iteration 1 -> no-op, no new commit
# ---------------------------------------------------------------------------
@test "B3: clean repo --pr/--iteration -> no-op, no new commit" {
    rev_before=$(git rev-list --count HEAD)
    run "$SCRIPT" --pr 5 --iteration 1
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.dirty')" = "false" ]
    [ "$(echo "$result" | jq -r '.committed')" = "false" ]
    [ "$(echo "$result" | jq -r '.pushed')" = "false" ]
    rev_after=$(git rev-list --count HEAD)
    [ "$rev_before" = "$rev_after" ]
}

# ---------------------------------------------------------------------------
# B4: dirty repo + valid local bare origin --pr 5 --iteration 2 ->
# dirty:true/committed:true/pushed:true, commit message pinned, clean tree,
# origin reaches the commit.
# ---------------------------------------------------------------------------
@test "B4: dirty repo + valid origin --pr/--iteration -> commit+push recovered" {
    BARE_DIR="$WORK_DIR/origin.git"
    git init -q --bare "$BARE_DIR"
    git remote add origin "$BARE_DIR"

    echo "b4 change" >> file.txt

    run "$SCRIPT" --pr 5 --iteration 2
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.dirty')" = "true" ]
    [ "$(echo "$result" | jq -r '.committed')" = "true" ]
    [ "$(echo "$result" | jq -r '.pushed')" = "true" ]

    head_msg=$(git log -1 --pretty=%s)
    [ "$head_msg" = "fix(pr-5): commit leftover review fixes (iteration 2)" ]

    [ -z "$(git status --porcelain)" ]

    local_head=$(git rev-parse HEAD)
    origin_head=$(git --git-dir="$BARE_DIR" rev-parse HEAD)
    [ "$local_head" = "$origin_head" ]
}

# ---------------------------------------------------------------------------
# B5: dirty repo without a usable origin --pr 5 --iteration 1 ->
# dirty:true/committed:true/pushed:false, still exit 0.
# ---------------------------------------------------------------------------
@test "B5: dirty repo, no usable origin -> committed true, pushed false" {
    echo "b5 change" >> file.txt

    run "$SCRIPT" --pr 5 --iteration 1
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.dirty')" = "true" ]
    [ "$(echo "$result" | jq -r '.committed')" = "true" ]
    [ "$(echo "$result" | jq -r '.pushed')" = "false" ]
}

# ---------------------------------------------------------------------------
# B6: outside a git repo --check-only -> exit 1, no JSON on stdout
# ---------------------------------------------------------------------------
@test "B6: outside git repo --check-only -> exit 1, no stdout JSON" {
    OUTSIDE_DIR="$WORK_DIR/outside"
    mkdir -p "$OUTSIDE_DIR"
    cd "$OUTSIDE_DIR" || exit 1

    exit_code=0
    "$SCRIPT" --check-only >"$WORK_DIR/stdout.txt" 2>"$WORK_DIR/stderr.txt" || exit_code=$?

    [ "$exit_code" -eq 1 ]
    [ ! -s "$WORK_DIR/stdout.txt" ]
}

# ---------------------------------------------------------------------------
# B7: bad args -> exit 1
# ---------------------------------------------------------------------------
@test "B7: missing --pr -> exit 1" {
    exit_code=0
    "$SCRIPT" --iteration 1 >"$WORK_DIR/stdout.txt" 2>"$WORK_DIR/stderr.txt" || exit_code=$?
    [ "$exit_code" -eq 1 ]
    [ ! -s "$WORK_DIR/stdout.txt" ]
}

@test "B7: non-integer --pr -> exit 1" {
    exit_code=0
    "$SCRIPT" --pr abc --iteration 1 >"$WORK_DIR/stdout.txt" 2>"$WORK_DIR/stderr.txt" || exit_code=$?
    [ "$exit_code" -eq 1 ]
    [ ! -s "$WORK_DIR/stdout.txt" ]
}

@test "B7: unknown flag -> exit 1" {
    exit_code=0
    "$SCRIPT" --bogus >"$WORK_DIR/stdout.txt" 2>"$WORK_DIR/stderr.txt" || exit_code=$?
    [ "$exit_code" -eq 1 ]
    [ ! -s "$WORK_DIR/stdout.txt" ]
}
