#!/usr/bin/env bats
# Regression guard: no tracked file may contain the deprecated slash-command prefix
# (the old-style prefix that was replaced; needle is split below to avoid self-match).
#
# The needle is built via printf split to avoid embedding the contiguous string
# in this very source file (which would cause a false positive on itself).

setup() {
    REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    NEEDLE="$(printf '%s%s' '/sc' ':')"
    SELF_REL="tests/no-sc-prefix.bats"
}

@test "no tracked file contains the deprecated slash-command prefix" {
    cd "$REPO_ROOT"
    mapfile -t FILES < <(git ls-files | grep -vF "$SELF_REL")
    # Sanity: repo must have tracked files
    [ "${#FILES[@]}" -gt 0 ]
    run grep -lF -- "$NEEDLE" "${FILES[@]}"
    # grep exits 1 (no match) on success; exit 2 means an error (e.g. unreadable path)
    [ "$status" -eq 1 ]
}

@test "no worktree path is tracked in the repo" {
    cd "$REPO_ROOT"
    [ "$(git ls-files | grep -c '.claude/worktrees/')" -eq 0 ]
}
