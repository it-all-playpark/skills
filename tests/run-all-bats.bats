#!/usr/bin/env bats
# run-all-bats.bats - Regression tests for tests/run-all-bats.sh discovery
# behavior (worktree exclusion of .claude/worktrees/**) and its parallel
# execution / result aggregation.
#
# Each test builds a fixture repository under $BATS_TEST_TMPDIR by copying
# the real run-all-bats.sh into a fresh tests/ dir. Since REPO_ROOT is
# derived from the script's own location, the fixture directory becomes the
# effective repo root for the copied script, letting us exercise discovery
# without touching the real repository.

setup() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE/tests"
    cp "$BATS_TEST_DIRNAME/run-all-bats.sh" "$FIXTURE/tests/"
}

# Fixture .bats content is written via printf (not a heredoc with a literal
# `@test` line) so that naive line-scanning `bats` implementations (some
# apt-packaged versions) don't mistake these fixture strings for real test
# definitions in *this* file, which causes spurious "duplicate test name"
# errors across the three tests below (each of which writes an "ok"/"leak"
# fixture). Building the `@` via a variable keeps `@test` from ever
# appearing at the start of a line in this source file.
AT='@'

write_ok_fixture() {
    printf '%stest "ok" { true; }\n' "$AT" > "$1"
}

write_leak_fixture() {
    printf '%stest "leak" { false; }\n' "$AT" > "$1"
}

@test "worktree 配下の .bats は discovery から除外される" {
    write_ok_fixture "$FIXTURE/sample.bats"
    mkdir -p "$FIXTURE/.claude/worktrees/df-999"
    write_leak_fixture "$FIXTURE/.claude/worktrees/df-999/leak.bats"

    run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
    [[ "$output" != *"leak.bats"* ]]
}

@test "worktree の有無で discovery 件数が変わらない" {
    write_ok_fixture "$FIXTURE/sample.bats"

    run bash "$FIXTURE/tests/run-all-bats.sh"
    [ "$status" -eq 0 ]
    first_count_line="$(echo "$output" | grep "Discovered .* file(s)")"

    mkdir -p "$FIXTURE/.claude/worktrees/df-999"
    write_leak_fixture "$FIXTURE/.claude/worktrees/df-999/leak.bats"

    run bash "$FIXTURE/tests/run-all-bats.sh"
    [ "$status" -eq 0 ]
    second_count_line="$(echo "$output" | grep "Discovered .* file(s)")"

    [ "$first_count_line" = "$second_count_line" ]
}

@test "worktree checkout 内から実行しても自身のテストは discovery される" {
    WT_FIXTURE="$BATS_TEST_TMPDIR/main/.claude/worktrees/df-1"
    mkdir -p "$WT_FIXTURE/tests"
    cp "$BATS_TEST_DIRNAME/run-all-bats.sh" "$WT_FIXTURE/tests/"
    write_ok_fixture "$WT_FIXTURE/sample.bats"

    run bash "$WT_FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
}

@test "並列実行: 1 ファイルの失敗で exit 1 になり Summary と Failed files に反映される" {
    write_ok_fixture "$FIXTURE/a.bats"
    write_leak_fixture "$FIXTURE/b.bats"
    write_ok_fixture "$FIXTURE/c.bats"

    RUN_ALL_BATS_JOBS=3 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 1 ]
    [[ "$output" == *"Summary: 2 passed, 1 failed"* ]]
    [[ "$output" == *"Failed files:"*"  - b.bats"* ]]
}

@test "並列実行: 完了順に関係なく出力は discovery 順にファイル単位でまとまる" {
    # a.bats は b.bats より遅く終わるが、出力は a → b の順に並ぶ
    printf '%stest "slow-a" { sleep 1; true; }\n' "$AT" > "$FIXTURE/a.bats"
    printf '%stest "fast-b" { true; }\n' "$AT" > "$FIXTURE/b.bats"

    RUN_ALL_BATS_JOBS=2 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"=== Running: a.bats ==="*"slow-a"*"=== Running: b.bats ==="*"fast-b"* ]]
}

@test "RUN_ALL_BATS_JOBS=1 は直列で全ファイルを実行する" {
    write_ok_fixture "$FIXTURE/a.bats"
    write_ok_fixture "$FIXTURE/b.bats"

    RUN_ALL_BATS_JOBS=1 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Running with 1 parallel job(s)."* ]]
    [[ "$output" == *"Summary: 2 passed, 0 failed"* ]]
}

@test "RUN_ALL_BATS_JOBS が正の整数でなければ exit 2" {
    write_ok_fixture "$FIXTURE/a.bats"

    for bad in 0 abc -1 1.5; do
        RUN_ALL_BATS_JOBS="$bad" run bash "$FIXTURE/tests/run-all-bats.sh"
        [ "$status" -eq 2 ]
        [[ "$output" == *"RUN_ALL_BATS_JOBS must be a positive integer"* ]]
    done
}
