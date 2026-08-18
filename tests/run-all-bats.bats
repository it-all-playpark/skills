#!/usr/bin/env bats
# run-all-bats.bats - Regression tests for tests/run-all-bats.sh discovery
# behavior, specifically worktree exclusion (.claude/worktrees/**).
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
    write_ok_fixture "$FIXTURE/sample.bats"
    echo "gitdir: /nonexistent" > "$FIXTURE/.git"

    run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
}
