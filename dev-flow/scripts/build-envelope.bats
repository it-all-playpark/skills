#!/usr/bin/env bats
# Tests for dev-flow/scripts/build-envelope.sh
#
# Run with: bats dev-flow/scripts/build-envelope.bats
# Skipped if `bats` not installed; CI runs them via tests/run-all-bats.sh.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow/scripts/build-envelope.sh"
    DECIDE="$SKILLS_REPO/_lib/scripts/flow-decide.sh"
    FLOW="$BATS_TMPDIR/flow.json"
    cat > "$FLOW" << 'EOF'
{
  "version": "2.1.0",
  "issue": 112,
  "status": "running",
  "children": [{"issue": 201}, {"issue": 202}, {"issue": 203}],
  "batches": [],
  "phases": [
    {"name": "decompose",  "status": "done",    "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "batch_loop", "status": "running", "attempts": 1, "retry_target": null, "failed_at": null, "score": null},
    {"name": "integrate",  "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "final_pr",   "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "pr_iterate", "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null}
  ]
}
EOF
}

# ---------------------------------------------------------------------------
# batch_loop
# ---------------------------------------------------------------------------

@test "batch_loop: maps issues_succeeded/failed to completed/failed_children" {
    run "$SCRIPT" batch_loop --flow-state "$FLOW" \
        --batch-result '{"issues_succeeded":2,"issues_failed":1,"results":[{"issue":201,"status":"success"},{"issue":202,"status":"failed"},{"issue":203,"status":"success"}]}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.phase')" = "batch_loop" ]
    [ "$(echo "$output" | jq -r '.completed_children')" = "2" ]
    [ "$(echo "$output" | jq -r '.failed_children')" = "1" ]
}

@test "batch_loop: skipped is aggregated from results[] into failed_children (Round3-c)" {
    run "$SCRIPT" batch_loop --flow-state "$FLOW" \
        --batch-result '{"issues_succeeded":1,"issues_failed":1,"results":[{"issue":201,"status":"success"},{"issue":202,"status":"failed"},{"issue":203,"status":"skipped"}]}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.completed_children')" = "1" ]
    # failed = issues_failed(1) + skipped(1) = 2
    [ "$(echo "$output" | jq -r '.failed_children')" = "2" ]
}

@test "batch_loop: invariant completed+failed == children fails when inconsistent" {
    run "$SCRIPT" batch_loop --flow-state "$FLOW" \
        --batch-result '{"issues_succeeded":1,"issues_failed":0,"results":[]}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"inconsistent"* ]]
}

@test "batch_loop: requires --flow-state" {
    run "$SCRIPT" batch_loop --batch-result '{"issues_succeeded":3,"issues_failed":0,"results":[]}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"--flow-state"* ]]
}

@test "batch_loop: missing required fields fails" {
    run "$SCRIPT" batch_loop --flow-state "$FLOW" --batch-result '{"status":"ok"}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"missing required fields"* ]]
}

@test "batch_loop: envelope feeds flow-decide -> dev-integrate" {
    env=$("$SCRIPT" batch_loop --flow-state "$FLOW" \
        --batch-result '{"issues_succeeded":3,"issues_failed":0,"results":[{"issue":201,"status":"success"},{"issue":202,"status":"success"},{"issue":203,"status":"success"}]}')
    echo "$env" | jq -c . > "$BATS_TMPDIR/env.json"
    run "$DECIDE" --flow-state "$FLOW" --phase batch_loop --result "$BATS_TMPDIR/env.json"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.next_action')" = "skill" ]
    [ "$(echo "$output" | jq -r '.skill')" = "dev-integrate" ]
}

# ---------------------------------------------------------------------------
# integrate
# ---------------------------------------------------------------------------

@test "integrate: type_check=passed + validation=passed -> tests_pass true" {
    run "$SCRIPT" integrate --integrate-result '{"status":"integrated","type_check":"passed","validation":"passed"}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.phase')" = "integrate" ]
    [ "$(echo "$output" | jq -r '.tests_pass')" = "true" ]
    [ "$(echo "$output" | jq -c '.merge_conflicts')" = "[]" ]
}

@test "integrate: type_check=skipped + validation=passed -> tests_pass true" {
    run "$SCRIPT" integrate --integrate-result '{"type_check":"skipped","validation":"passed"}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.tests_pass')" = "true" ]
}

@test "integrate: type_check=failed -> tests_pass false" {
    run "$SCRIPT" integrate --integrate-result '{"type_check":"failed","validation":"passed"}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.tests_pass')" = "false" ]
}

@test "integrate: validation=failed -> tests_pass false" {
    run "$SCRIPT" integrate --integrate-result '{"type_check":"passed","validation":"failed"}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.tests_pass')" = "false" ]
}

@test "integrate: merge_conflicts always empty (auto-merge-child completed merges)" {
    env=$("$SCRIPT" integrate --integrate-result '{"type_check":"passed","validation":"passed"}')
    echo "$env" | jq -c . > "$BATS_TMPDIR/env.json"
    run "$DECIDE" --flow-state "$FLOW" --phase integrate --result "$BATS_TMPDIR/env.json"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.next_action')" = "skill" ]
    [ "$(echo "$output" | jq -r '.skill')" = "git-pr" ]
}

# ---------------------------------------------------------------------------
# final_pr
# ---------------------------------------------------------------------------

@test "final_pr: maps git-pr pr_url + ci_status arg" {
    run "$SCRIPT" final_pr --pr-result '{"pr_url":"https://github.com/x/y/pull/5","title":"t","branch":"b"}' --ci-status passed
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.phase')" = "final_pr" ]
    [ "$(echo "$output" | jq -r '.pr_url')" = "https://github.com/x/y/pull/5" ]
    [ "$(echo "$output" | jq -r '.ci_status')" = "passed" ]
}

@test "final_pr: ci pending then passed (polling mock)" {
    # pending envelope -> flow-decide abort
    env_pending=$("$SCRIPT" final_pr --pr-result '{"pr_url":"https://github.com/x/y/pull/5"}' --ci-status pending)
    [ "$(echo "$env_pending" | jq -r '.ci_status')" = "pending" ]
    # passed envelope -> flow-decide pr-iterate
    env_passed=$("$SCRIPT" final_pr --pr-result '{"pr_url":"https://github.com/x/y/pull/5"}' --ci-status passed)
    echo "$env_passed" | jq -c . > "$BATS_TMPDIR/env.json"
    run "$DECIDE" --flow-state "$FLOW" --phase final_pr --result "$BATS_TMPDIR/env.json"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.skill')" = "pr-iterate" ]
}

@test "final_pr: invalid ci-status rejected" {
    run "$SCRIPT" final_pr --pr-result '{"pr_url":"https://github.com/x/y/pull/5"}' --ci-status timeout
    [ "$status" -ne 0 ]
    [[ "$output" == *"ci-status"* ]]
}

@test "final_pr: requires --ci-status" {
    run "$SCRIPT" final_pr --pr-result '{"pr_url":"https://github.com/x/y/pull/5"}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"--ci-status"* ]]
}

@test "final_pr: missing pr_url fails" {
    run "$SCRIPT" final_pr --pr-result '{"title":"t"}' --ci-status passed
    [ "$status" -ne 0 ]
    [[ "$output" == *"pr_url"* ]]
}

# ---------------------------------------------------------------------------
# pr_iterate
# ---------------------------------------------------------------------------

@test "pr_iterate: maps status->decision, current_iteration->iterations" {
    run "$SCRIPT" pr_iterate --iterate-state '{"version":"1.0","status":"lgtm","current_iteration":3}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.phase')" = "pr_iterate" ]
    [ "$(echo "$output" | jq -r '.decision')" = "lgtm" ]
    [ "$(echo "$output" | jq -r '.iterations')" = "3" ]
}

@test "pr_iterate: max_reached decision" {
    run "$SCRIPT" pr_iterate --iterate-state '{"status":"max_reached","current_iteration":10}'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.decision')" = "max_reached" ]
}

@test "pr_iterate: in_progress aborts (must not build until terminal)" {
    run "$SCRIPT" pr_iterate --iterate-state '{"status":"in_progress","current_iteration":2}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"in_progress"* ]]
}

@test "pr_iterate: envelope feeds flow-decide -> complete on lgtm" {
    env=$("$SCRIPT" pr_iterate --iterate-state '{"status":"lgtm","current_iteration":2}')
    echo "$env" | jq -c . > "$BATS_TMPDIR/env.json"
    run "$DECIDE" --flow-state "$FLOW" --phase pr_iterate --result "$BATS_TMPDIR/env.json"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.next_action')" = "complete" ]
}

# ---------------------------------------------------------------------------
# generic
# ---------------------------------------------------------------------------

@test "unknown phase fails" {
    run "$SCRIPT" decompose --batch-result '{}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown phase"* ]]
}

@test "no phase arg fails" {
    run "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "accepts file path for result input" {
    echo '{"issues_succeeded":3,"issues_failed":0,"results":[]}' > "$BATS_TMPDIR/br.json"
    run "$SCRIPT" batch_loop --flow-state "$FLOW" --batch-result "$BATS_TMPDIR/br.json"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.completed_children')" = "3" ]
}
