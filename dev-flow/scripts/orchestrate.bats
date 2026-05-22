#!/usr/bin/env bats
# Tests for dev-flow/scripts/orchestrate.sh (child-split decision loop, Stage 3)
#
# Run with: bats dev-flow/scripts/orchestrate.bats
# Skipped if `bats` not installed; CI runs them via tests/run-all-bats.sh.
#
# Uses --dry-run + ORCHESTRATE_DRY_* hooks so no real skills/network are invoked.
# Phase transitions go through the real flow-decide.sh + build-envelope.sh +
# flow-update.sh, exercising the full deterministic decision loop.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow/scripts/orchestrate.sh"
    WT="$BATS_TMPDIR/wt"
    mkdir -p "$WT/.claude"
    FLOW="$BATS_TMPDIR/flow.json"
    write_flow
}

# bats 1.2's `run` merges stderr into $output. orchestrate.sh logs progress to
# stderr, which corrupts `jq "$output"`. `orch` runs the script via bash -c with
# stderr discarded, so $output holds only the clean JSON result emitted on stdout.
# Tests that assert die_json diagnostics (written to stderr) use plain `run`
# instead. ORCHESTRATE_DRY_* env vars are inherited, so export them before orch.
orch() {
    run bash -c '"$0" "$@" 2>/dev/null' "$SCRIPT" "$@"
}

# Write a fresh flow.json with N completed children, decompose done, rest pending.
write_flow() {
    cat > "$FLOW" << 'EOF'
{
  "version": "2.1.0",
  "issue": 112,
  "status": "running",
  "integration_branch": {"name": "integration/issue-112-x", "base": "dev"},
  "children": [{"issue": 201, "status": "completed"}, {"issue": 202, "status": "completed"}],
  "batches": [{"batch": 1, "mode": "serial", "children": [201, 202]}],
  "phases": [
    {"name": "decompose",  "status": "done",    "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "batch_loop", "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "integrate",  "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "final_pr",   "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null},
    {"name": "pr_iterate", "status": "pending", "attempts": 0, "retry_target": null, "failed_at": null, "score": null}
  ],
  "final_pr": null,
  "config": {"strategy": "tdd", "depth": "standard", "lang": "ja", "base_branch": "dev", "env_mode": "hardlink"},
  "created_at": "2026-05-22T00:00:00Z",
  "updated_at": "2026-05-22T00:00:00Z"
}
EOF
}

@test "dry-run completes all 4 phases (batch_loop->integrate->final_pr->pr_iterate)" {
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "completed" ]
    # all phases done
    [ "$(jq -r '[.phases[] | select(.status != "done")] | length' "$FLOW")" = "0" ]
    [ "$(jq -r '.status' "$FLOW")" = "integrated" ]
}

@test "requires --flow-state and --worktree" {
    run "$SCRIPT" --worktree "$WT" --dry-run
    [ "$status" -ne 0 ]
    run "$SCRIPT" --flow-state "$FLOW" --dry-run
    [ "$status" -ne 0 ]
}

@test "rejects flow.json version != 2.1.0 (no-backcompat)" {
    # die_json writes to stderr; plain `run` (which merges) captures it.
    jq '.version = "2.0.0"' "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    run "$SCRIPT" --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -ne 0 ]
    [[ "$output" == *"2.1.0"* ]]
}

@test "aborts when decompose phase not done" {
    # die_json writes to stderr; plain `run` (which merges) captures it.
    jq '(.phases[] | select(.name=="decompose")).status = "pending"' "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    run "$SCRIPT" --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -ne 0 ]
    [[ "$output" == *"decompose"* ]]
}

@test "resumes from integrate when batch_loop already done" {
    jq '(.phases[] | select(.name=="batch_loop")).status = "done"' "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "completed" ]
}

@test "all phases done -> completed no-op" {
    jq '.phases |= map(.status = "done")' "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "completed" ]
}

@test "abort when batch_loop has failed children and no --allow-partial" {
    echo '{"issues_succeeded":1,"issues_failed":1,"results":[{"issue":201,"status":"success"},{"issue":202,"status":"failed"}]}' > "$BATS_TMPDIR/br.json"
    export ORCHESTRATE_DRY_BATCH_RESULT="$BATS_TMPDIR/br.json"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 2 ]
    [ "$(echo "$output" | jq -r '.status')" = "aborted" ]
    [ "$(echo "$output" | jq -r '.phase')" = "batch_loop" ]
    [ "$(jq -r '.status' "$FLOW")" = "failed" ]
    [ "$(jq -r '.phases[]|select(.name=="batch_loop").status' "$FLOW")" = "failed" ]
}

@test "continue past partial batch_loop with --allow-partial" {
    echo '{"issues_succeeded":1,"issues_failed":1,"results":[{"issue":201,"status":"success"},{"issue":202,"status":"failed"}]}' > "$BATS_TMPDIR/br.json"
    export ORCHESTRATE_DRY_BATCH_RESULT="$BATS_TMPDIR/br.json"
    orch --flow-state "$FLOW" --worktree "$WT" --allow-partial --dry-run
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "completed" ]
}

@test "abort when final_pr CI status is not passed" {
    jq '(.phases[]|select(.name=="batch_loop")).status="done" | (.phases[]|select(.name=="integrate")).status="done"' "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    export ORCHESTRATE_DRY_CI_STATUS="failed"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 2 ]
    [ "$(echo "$output" | jq -r '.phase')" = "final_pr" ]
    [[ "$(echo "$output" | jq -r '.reason')" == *"CI status=failed"* ]]
}

@test "batch_loop skipped children counted as failed (consistency with build-envelope)" {
    # 1 success + 1 skipped: failed_children=1 -> abort without --allow-partial
    echo '{"issues_succeeded":1,"issues_failed":0,"results":[{"issue":201,"status":"success"},{"issue":202,"status":"skipped"}]}' > "$BATS_TMPDIR/br.json"
    export ORCHESTRATE_DRY_BATCH_RESULT="$BATS_TMPDIR/br.json"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 2 ]
    [ "$(echo "$output" | jq -r '.phase')" = "batch_loop" ]
}

@test "marks phases done in order on success" {
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 0 ]
    [ "$(jq -r '.phases[]|select(.name=="batch_loop").status' "$FLOW")" = "done" ]
    [ "$(jq -r '.phases[]|select(.name=="integrate").status' "$FLOW")" = "done" ]
    [ "$(jq -r '.phases[]|select(.name=="final_pr").status' "$FLOW")" = "done" ]
    [ "$(jq -r '.phases[]|select(.name=="pr_iterate").status' "$FLOW")" = "done" ]
}

# --- Resume-from-failed / retry (Q5) ---

@test "resume from failed batch_loop with retry_target fires retry, bumps attempts, completes" {
    # Seed a failed batch_loop carrying a non-abort retry_target (prior-run residue).
    jq '(.phases[]|select(.name=="batch_loop")) |= (.status="failed" | .retry_target="batch_loop" | .attempts=0)' \
        "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "completed" ]
    # retry bumped attempts before re-running the phase
    [ "$(jq -r '.phases[]|select(.name=="batch_loop").attempts' "$FLOW")" = "1" ]
    [ "$(jq -r '.phases[]|select(.name=="batch_loop").status' "$FLOW")" = "done" ]
}

@test "resume from failed phase at max attempts aborts (retry NOT fired)" {
    jq '(.phases[]|select(.name=="batch_loop")) |= (.status="failed" | .retry_target="batch_loop" | .attempts=3)' \
        "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 2 ]
    [ "$(echo "$output" | jq -r '.status')" = "aborted" ]
    [[ "$(echo "$output" | jq -r '.reason')" == *"max retry"* ]]
    # attempts must NOT be bumped past the cap
    [ "$(jq -r '.phases[]|select(.name=="batch_loop").attempts' "$FLOW")" = "3" ]
}

@test "resume from failed phase with retry_target=abort aborts immediately" {
    jq '(.phases[]|select(.name=="batch_loop")) |= (.status="failed" | .retry_target="abort" | .attempts=0)' \
        "$FLOW" > "$FLOW.tmp" && mv "$FLOW.tmp" "$FLOW"
    orch --flow-state "$FLOW" --worktree "$WT" --dry-run
    [ "$status" -eq 2 ]
    [ "$(echo "$output" | jq -r '.status')" = "aborted" ]
    # not re-run: still failed, attempts untouched
    [ "$(jq -r '.phases[]|select(.name=="batch_loop").attempts' "$FLOW")" = "0" ]
}
