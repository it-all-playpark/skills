#!/usr/bin/env bats
# Tests for the 2x2x2 dogfood comparison matrix produced by
# `trust-receipts-report.sh --matrix <dir>` (issue #413, epic #390 Phase 5).
#
# Consumes the checked-in 32-fixture corpus
# (dev-flow-doctor/tests/fixtures/trust-receipts/matrix/<axis>-s{on|off}-e{on|off}-d{on|off}.json)
# covering the 4 fixture axes (long-issue/coding/pr-side-effect/e2e) x 2^3
# layer-mode combos (surfaceproof x evalseal x effectdelta, each off|shadow).
#
# Fixture design:
#   - duration_seconds increases with on-layer count (100 off-baseline,
#     +30s per on layer, capped at 190 for all-3-on) so off vs on cells are
#     separable by duration_p50.
#   - only e2e-son-eon-don (all 3 layers on) plants an evalseal verdict=="fail"
#     receipt alongside eval_verdict=="pass", producing the single
#     false_completion signal in the whole corpus (layer-on-only detection
#     contrast: the e2e all-off cell carries no trust keys at all, so no
#     contradiction signal is even representable there).

SCRIPT_PATH="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/trust-receipts-report.sh"
MATRIX_FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")/../tests/fixtures/trust-receipts/matrix" && pwd)"

# ---------------------------------------------------------------------------
# (a) all 4 axes x 8 cells are filled (run_count==1 each, 32 cells total)
# ---------------------------------------------------------------------------
@test "(a) 4 axis x 8 cell matrix is fully populated from the 32-fixture corpus" {
    run bash "$SCRIPT_PATH" --matrix "$MATRIX_FIXTURES"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    schema=$(printf '%s\n' "$output" | jq -r '.schema')
    [ "$schema" = "trust-receipts-matrix/v1" ]

    cell_count=$(printf '%s\n' "$output" | jq '.cells | length')
    [ "$cell_count" -eq 32 ]

    total_run_count=$(printf '%s\n' "$output" | jq '[.cells[].run_count] | add')
    [ "$total_run_count" -eq 32 ]

    unfilled=$(printf '%s\n' "$output" | jq '[.cells[] | select(.run_count != 1)] | length')
    [ "$unfilled" -eq 0 ]

    for axis in long-issue coding pr-side-effect e2e; do
        axis_cells=$(printf '%s\n' "$output" | jq --arg a "$axis" '[.cells[] | select(.axis==$a)] | length')
        [ "$axis_cells" -eq 8 ]
    done
}

# ---------------------------------------------------------------------------
# (b) false_completion is detected ONLY for e2e-son-eon-don (all layers on);
#     no other cell (including the e2e all-off cell) shows the signal.
# ---------------------------------------------------------------------------
@test "(b) false_completion=1 only at e2e all-shadow cell; corpus-wide total is 1" {
    run bash "$SCRIPT_PATH" --matrix "$MATRIX_FIXTURES"
    [ "$status" -eq 0 ]

    total_fc=$(printf '%s\n' "$output" | jq '[.cells[].false_completion_count] | add')
    [ "$total_fc" -eq 1 ]

    e2e_all_on_fc=$(printf '%s\n' "$output" | jq \
        '[.cells[] | select(.axis=="e2e" and .layer_modes.surfaceproof=="shadow" and .layer_modes.evalseal=="shadow" and .layer_modes.effectdelta=="shadow")][0].false_completion_count')
    [ "$e2e_all_on_fc" -eq 1 ]

    e2e_all_off_fc=$(printf '%s\n' "$output" | jq \
        '[.cells[] | select(.axis=="e2e" and .layer_modes.surfaceproof=="off" and .layer_modes.evalseal=="off" and .layer_modes.effectdelta=="off")][0].false_completion_count')
    [ "$e2e_all_off_fc" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (c) duration_p50 separates off cells from on cells (added-latency signal)
# ---------------------------------------------------------------------------
@test "(c) duration_p50 of all-off cell is lower than all-on cell for every axis" {
    run bash "$SCRIPT_PATH" --matrix "$MATRIX_FIXTURES"
    [ "$status" -eq 0 ]

    for axis in long-issue coding pr-side-effect e2e; do
        off_p50=$(printf '%s\n' "$output" | jq \
            --arg a "$axis" '[.cells[] | select(.axis==$a and .layer_modes.surfaceproof=="off" and .layer_modes.evalseal=="off" and .layer_modes.effectdelta=="off")][0].duration_p50')
        on_p50=$(printf '%s\n' "$output" | jq \
            --arg a "$axis" '[.cells[] | select(.axis==$a and .layer_modes.surfaceproof=="shadow" and .layer_modes.evalseal=="shadow" and .layer_modes.effectdelta=="shadow")][0].duration_p50')
        [ "$off_p50" -eq 100 ]
        [ "$on_p50" -eq 190 ]
        [ "$on_p50" -gt "$off_p50" ]
    done
}

# ---------------------------------------------------------------------------
# (d) out-of-enum .context.layer_modes value -> exit 1, explicit JSON error
#     (fixture generated into $BATS_TEST_TMPDIR, never committed)
# ---------------------------------------------------------------------------
@test "(d) out-of-enum layer_modes value in a temp fixture -> exit 1 explicit error" {
    BAD_DIR="$BATS_TEST_TMPDIR/bad-matrix"
    mkdir -p "$BAD_DIR"
    cat > "$BAD_DIR/01-bad-mode.json" <<'EOF'
{
  "version": "1.0.0",
  "id": "matrix-bats-bad-mode",
  "timestamp": "2026-07-01T00:00:00Z",
  "skill": "dev-flow",
  "outcome": "success",
  "source": "skill",
  "context": {
    "fixture_axis": "e2e",
    "layer_modes": { "surfaceproof": "on", "evalseal": "off", "effectdelta": "off" }
  },
  "telemetry": { "eval_verdict": "pass", "duration_seconds": 100 }
}
EOF

    run bash "$SCRIPT_PATH" --matrix "$BAD_DIR"
    [ "$status" -eq 1 ]
    printf '%s\n' "$output" | jq -e '.status == "error"'
}
