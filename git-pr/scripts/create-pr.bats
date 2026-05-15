#!/usr/bin/env bats
# Tests for git-pr/scripts/create-pr.sh
#
# Strategy: shim out `gh` with a stub that records arguments to a file.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/git-pr/scripts/create-pr.sh"
    GH_LOG="$BATS_TMPDIR/gh.log"
    : > "$GH_LOG"
    # Create gh stub
    #
    # NOTE: Each invocation writes ONE record per call:
    #   "<arg1> <arg2> ... <argN>"  (newlines inside argv are escaped to <NL>)
    # then a final newline. Using `echo "$@"` raw would interleave argument
    # values that themselves contain newlines (e.g. PR body), making per-line
    # `grep "pr create"` unreliable: the body's leading line would split off
    # and hide the trailing flags. By escaping argv newlines we keep the whole
    # invocation on one log line.
    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/gh" << EOF
#!/usr/bin/env bash
{
    sep=""
    for a in "\$@"; do
        printf "%s%s" "\$sep" "\${a//$'\n'/<NL>}"
        sep=" "
    done
    printf "\n"
} >> "$GH_LOG"
case "\$1" in
    issue)
        # gh issue view --json title,labels
        echo '{"title":"test issue","labels":[{"name":"enhancement"}]}'
        ;;
    pr)
        # gh pr create -> echo URL
        echo "https://github.com/test/repo/pull/42"
        ;;
esac
EOF
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
    # Provide git context
    cd "$BATS_TMPDIR"
    rm -rf test-repo && mkdir test-repo && cd test-repo
    git init -q
    git checkout -q -b feature/issue-99-test
    : > a.txt
    git add a.txt
    git -c user.email=t@t.t -c user.name=test commit -q -m "init"
}

@test "creates non-draft PR by default" {
    cd "$BATS_TMPDIR/test-repo"
    run "$SCRIPT" 99 --base dev --worktree "$BATS_TMPDIR/test-repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"draft": false'* ]]
    # gh pr create should NOT have --draft
    GH_PR_LINE=$(grep "pr create" "$GH_LOG" || true)
    [[ -n "$GH_PR_LINE" ]]
    [[ "$GH_PR_LINE" != *"--draft"* ]]
}

@test "creates draft PR with --draft flag" {
    cd "$BATS_TMPDIR/test-repo"
    run "$SCRIPT" 99 --base dev --draft --worktree "$BATS_TMPDIR/test-repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"draft": true'* ]]
    # gh pr create should have --draft
    GH_PR_LINE=$(grep "pr create" "$GH_LOG" || true)
    [[ -n "$GH_PR_LINE" ]]
    [[ "$GH_PR_LINE" == *"--draft"* ]]
}

@test "errors when issue number missing" {
    cd "$BATS_TMPDIR/test-repo"
    run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"issue_number_required"* ]]
}

@test "auto-prepends emoji prefix from label" {
    cd "$BATS_TMPDIR/test-repo"
    run "$SCRIPT" 99 --base dev --worktree "$BATS_TMPDIR/test-repo"
    [ "$status" -eq 0 ]
    GH_PR_LINE=$(grep "pr create" "$GH_LOG" || true)
    [[ "$GH_PR_LINE" == *"feat:"* ]]
}

@test "custom --title overrides auto title" {
    cd "$BATS_TMPDIR/test-repo"
    run "$SCRIPT" 99 --base dev --title "My custom title" --worktree "$BATS_TMPDIR/test-repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *"My custom title"* ]]
}
