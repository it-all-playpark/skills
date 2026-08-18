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

@test "worktree 配下の .bats は discovery から除外される" {
    cat > "$FIXTURE/sample.bats" <<'EOF'
@test "ok" { true; }
EOF
    mkdir -p "$FIXTURE/.claude/worktrees/df-999"
    cat > "$FIXTURE/.claude/worktrees/df-999/leak.bats" <<'EOF'
@test "leak" { false; }
EOF

    run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
    [[ "$output" != *"leak.bats"* ]]
}

@test "worktree の有無で discovery 件数が変わらない" {
    cat > "$FIXTURE/sample.bats" <<'EOF'
@test "ok" { true; }
EOF

    run bash "$FIXTURE/tests/run-all-bats.sh"
    [ "$status" -eq 0 ]
    first_count_line="$(echo "$output" | grep "Discovered .* file(s)")"

    mkdir -p "$FIXTURE/.claude/worktrees/df-999"
    cat > "$FIXTURE/.claude/worktrees/df-999/leak.bats" <<'EOF'
@test "leak" { false; }
EOF

    run bash "$FIXTURE/tests/run-all-bats.sh"
    [ "$status" -eq 0 ]
    second_count_line="$(echo "$output" | grep "Discovered .* file(s)")"

    [ "$first_count_line" = "$second_count_line" ]
}

@test "worktree checkout 内から実行しても自身のテストは discovery される" {
    cat > "$FIXTURE/sample.bats" <<'EOF'
@test "ok" { true; }
EOF
    echo "gitdir: /nonexistent" > "$FIXTURE/.git"

    run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
}
