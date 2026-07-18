#!/usr/bin/env bats
# Tests for github-issue-orchestrator/scripts/create_issue.py
#
# Focus: the pre-flight AC lint gate (lint_ac()) invoked at the top of run(),
# exercised only through the --dry-run path so `gh` is never required.
#
# verdict handling contract:
#   t1            -> silent pass
#   t2            -> stderr Warning, continue
#   non_compliant -> Error on stderr (with remediation hint), exit 1
#   lint script missing / bad JSON / other non-zero exit -> RuntimeError -> exit 1

setup() {
    command -v python3 >/dev/null || skip "python3 not available"

    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/github-issue-orchestrator/scripts/create_issue.py"

    write_body() {
        local out="$1"
        shift
        printf '%s\n' "$@" > "$out"
    }
}

@test "(1) T1準拠 body + --dry-run -> exit 0, Dry run プレビュー出力" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "# Title" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Dry run: issue will not be created."* ]]
}

@test "(2) T2 body + --dry-run -> exit 0 かつ stderr に Warning" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 受け入れ基準" \
        "- foo" \
        "- bar"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Warning"* ]]
    [[ "$output" == *"T2"* ]]
}

@test "(3) 見出しなし non_compliant body + --dry-run -> exit 1 かつ是正手順を含む Error" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## Tasks" \
        "- [ ] not an AC section"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"Error"* ]]
    [[ "$output" == *"受け入れ基準"* ]]
}

@test "(4) 空 body file -> exit 1 (既存 ensure_body_file 挙動の regression 確認)" {
    BODY="$BATS_TEST_TMPDIR/empty.md"
    : > "$BODY"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"Error"* ]]
    [[ "$output" == *"body file is empty"* ]]
}
