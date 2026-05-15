#!/usr/bin/env bats
# Tests for _lib/scripts/integration-branch.sh

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_lib/scripts/integration-branch.sh"
}

teardown() {
    # Best-effort cleanup of any test branches that leaked
    for n in 99001 99002 99003; do
        for b in $(git branch --list "integration/issue-${n}-*" 2>/dev/null); do
            git branch -D "$b" >/dev/null 2>&1 || true
        done
    done
}

@test "name with explicit slug computes branch correctly" {
    run "$SCRIPT" name --issue 1234 --slug "my-feature"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"branch": "integration/issue-1234-my-feature"'* ]]
    [[ "$output" == *'"slug": "my-feature"'* ]]
}

@test "name slugifies special characters" {
    run "$SCRIPT" name --issue 1 --slug "Foo Bar! @#%"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"slug": "foo-bar"'* ]]
}

@test "name truncates slug to 30 chars" {
    run "$SCRIPT" name --issue 1 --slug "this-slug-is-way-too-long-and-must-be-truncated"
    [ "$status" -eq 0 ]
    # 30-char cap (after lowercase + sanitize); trailing dash trimmed
    [[ "$output" == *'"slug":'* ]]
    LENGTH=$(echo "$output" | jq -r '.slug | length')
    [[ "$LENGTH" -le 30 ]]
}

@test "create requires --base" {
    run "$SCRIPT" create --issue 99001 --slug "x"
    [ "$status" -ne 0 ]
    [[ "$output" == *"--base is required"* ]]
}

@test "create creates branch then idempotent on re-run" {
    git rev-parse --verify origin/dev >/dev/null 2>&1 || skip "origin/dev not present"
    run "$SCRIPT" create --issue 99002 --slug "alpha" --base origin/dev
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "created"'* ]]
    # Re-run: must be exists
    run "$SCRIPT" create --issue 99002 --slug "alpha" --base origin/dev
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "exists"'* ]]
}

@test "cleanup deletes branch with no unmerged commits" {
    git rev-parse --verify origin/dev >/dev/null 2>&1 || skip "origin/dev not present"
    "$SCRIPT" create --issue 99003 --slug "beta" --base origin/dev >/dev/null
    run "$SCRIPT" cleanup --issue 99003 --slug "beta"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "cleaned"'* ]]
}

@test "cleanup is skipped when branch does not exist" {
    run "$SCRIPT" cleanup --issue 99099 --slug "nonexistent"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "skipped"'* ]]
}

@test "missing --issue returns error" {
    run "$SCRIPT" name
    [ "$status" -ne 0 ]
    [[ "$output" == *"--issue is required"* ]]
}

@test "non-numeric --issue returns error" {
    run "$SCRIPT" name --issue foo
    [ "$status" -ne 0 ]
    [[ "$output" == *"positive integer"* ]]
}

@test "unknown subcommand returns error" {
    run "$SCRIPT" wobble --issue 1
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown subcommand"* ]]
}
