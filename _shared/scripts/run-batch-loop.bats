#!/usr/bin/env bats
# Tests for _shared/scripts/run-batch-loop.sh
#
# Run with: bats _shared/scripts/run-batch-loop.bats
# Skipped if `bats` not installed; CI runs them manually.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/run-batch-loop.sh"
    BATCHES_JSON="$BATS_TMPDIR/batches.json"
    cat > "$BATCHES_JSON" << 'EOF'
[
  {"batch": 1, "mode": "serial",   "children": [101, 102]},
  {"batch": 2, "mode": "parallel", "children": [201, 202]},
  {"batch": 3, "mode": "serial",   "children": [301]}
]
EOF
}

@test "ok status when all issues succeed" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "ok"'* ]]
    [[ "$output" == *'"issues_succeeded": 5'* ]]
    [[ "$output" == *'"issues_failed": 0'* ]]
}

@test "partial status when some issues fail" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" \
        --issue-runner 'if [ "{issue}" = "102" ]; then exit 1; else exit 0; fi'
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "partial"'* ]]
    [[ "$output" == *'"issues_failed": 1'* ]]
}

@test "failed status when all issues fail" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "false"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "failed"'* ]]
    [[ "$output" == *'"issues_failed": 5'* ]]
}

@test "--batch-from limits to specified range" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" --batch-from 2
    [ "$status" -eq 0 ]
    [[ "$output" == *'"batches_processed": 2'* ]]
    [[ "$output" == *'"issues_succeeded": 3'* ]]
}

@test "--batch-from --batch-to limits to single batch" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" --batch-from 2 --batch-to 2
    [ "$status" -eq 0 ]
    [[ "$output" == *'"batches_processed": 1'* ]]
    [[ "$output" == *'"issues_succeeded": 2'* ]]
}

@test "--on-success callback is invoked per successful issue" {
    LOG="$BATS_TMPDIR/success.log"
    : > "$LOG"
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" \
        --on-success "echo {issue} >> $LOG"
    [ "$status" -eq 0 ]
    [[ "$(sort -n "$LOG" | tr '\n' ' ')" == "101 102 201 202 301 " ]]
}

@test "--on-failure callback is invoked for failed issues" {
    LOG="$BATS_TMPDIR/failure.log"
    : > "$LOG"
    run "$SCRIPT" --batches-json "$BATCHES_JSON" \
        --issue-runner 'if [ "{issue}" = "201" ]; then exit 1; else exit 0; fi' \
        --on-failure "echo {issue} >> $LOG"
    [ "$status" -eq 0 ]
    [ "$(cat "$LOG")" = "201" ]
}

@test "errors when batches-json is missing" {
    run "$SCRIPT" --batches-json /nonexistent/path --issue-runner "true"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Batches JSON not found"* ]]
}

@test "errors when issue-runner is missing" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON"
    [ "$status" -ne 0 ]
    [[ "$output" == *"--issue-runner is required"* ]]
}

@test "errors on unknown batch mode" {
    cat > "$BATCHES_JSON" << 'EOF'
[{"batch": 1, "mode": "concurrent", "children": [1]}]
EOF
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown batch mode"* ]]
}

@test "errors when batch-from > batch-to" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" \
        --batch-from 3 --batch-to 1
    [ "$status" -ne 0 ]
    [[ "$output" == *"must be <="* ]]
}

@test "errors when no batches in range" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" \
        --batch-from 99
    [ "$status" -ne 0 ]
    [[ "$output" == *"No batches in range"* ]]
}

@test "state-file is written after each batch" {
    STATE="$BATS_TMPDIR/state.json"
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" \
        --state-file "$STATE"
    [ "$status" -eq 0 ]
    [ -f "$STATE" ]
    [[ "$(jq -r '.batches_processed' "$STATE")" = "3" ]]
}

@test "--fail-fast: default (off) processes all batches even with failures" {
    # Batch 1 fails (issue 102), batch 2 and 3 still run.
    run "$SCRIPT" --batches-json "$BATCHES_JSON" \
        --issue-runner 'if [ "{issue}" = "102" ]; then exit 1; else exit 0; fi'
    [ "$status" -eq 0 ]
    [[ "$output" == *'"batches_processed": 3'* ]]
    [[ "$output" == *'"batches_skipped": 0'* ]]
    [[ "$output" == *'"fail_fast_triggered": false'* ]]
}

@test "--fail-fast: skips subsequent batches after a batch has any failure" {
    # Batch 1 has issue 102 failing → batch 2 and 3 should be skipped.
    run "$SCRIPT" --batches-json "$BATCHES_JSON" \
        --issue-runner 'if [ "{issue}" = "102" ]; then exit 1; else exit 0; fi' \
        --fail-fast
    [ "$status" -eq 0 ]
    [[ "$output" == *'"batches_processed": 1'* ]]
    [[ "$output" == *'"batches_skipped": 2'* ]]
    [[ "$output" == *'"fail_fast_triggered": true'* ]]
    # Issue 101 succeeded; issue 102 failed in batch 1
    [[ "$output" == *'"issues_succeeded": 1'* ]]
    [[ "$output" == *'"issues_failed": 1'* ]]
    # Batch 2 (2 children) + Batch 3 (1 child) = 3 skipped
    SKIPPED_COUNT=$(echo "$output" | jq '[.results[] | select(.status == "skipped")] | length')
    [ "$SKIPPED_COUNT" -eq 3 ]
}

@test "--fail-fast: no failure → behaves like default" {
    run "$SCRIPT" --batches-json "$BATCHES_JSON" --issue-runner "true" --fail-fast
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "ok"'* ]]
    [[ "$output" == *'"batches_processed": 3'* ]]
    [[ "$output" == *'"batches_skipped": 0'* ]]
    [[ "$output" == *'"fail_fast_triggered": false'* ]]
}
