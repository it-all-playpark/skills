#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/trust-receipts-report.sh
#
# Consumes REAL trust receipts (SurfaceProof/EvalSeal/EffectDelta shadow telemetry —
# issue #390 Phase 5, AC-13) from dev-flow journal entries and reports:
#   layer_status / missing_receipt / inconclusive / effect_mismatch /
#   false_completion / latency / cost_proxy, plus optional --slo Go/No-Go and
#   --matrix 2x2x2 fixture comparison.
#
# Fixture journal (dev-flow-doctor/tests/fixtures/trust-receipts/base/*.json) --
# 6 committed static entries, timestamps 2026-01-10..15. --until 2026-02-01T00:00:00Z
# --window 30d => since 2026-01-02T00:00:00Z, all fixtures fall inside the window
# (deterministic, "now"-independent).
#
# Fixture summary (run ids run-001..run-005 trust-active, run-006 legacy/trust-inactive):
#   01-clean:                    surfaceproof pass, evalseal pass, effectdelta pass
#   02-missing-evalseal:         surfaceproof pass, (no evalseal receipt), effectdelta pass
#   03-inconclusive-surfaceproof: surfaceproof inconclusive/PROBE_FAILED, evalseal pass, effectdelta pass
#   04-effect-mismatch-duplicate: surfaceproof pass, evalseal pass, effectdelta fail/DUPLICATE_EFFECT
#   05-false-completion:         surfaceproof pass, evalseal fail (eval_verdict=="pass" anyway), effectdelta pass
#   06-legacy-no-trust-keys:     no trust_run_id/trust_surfaceproof_shadow/trust_receipts (trust-inactive)

SCRIPT_PATH="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/trust-receipts-report.sh"
FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")/../tests/fixtures/trust-receipts/base" && pwd)"

UNTIL="2026-02-01T00:00:00Z"

setup() {
    SKILL_CONFIG_PATH="$BATS_TMPDIR/cfg-$$-${BATS_TEST_NUMBER:-0}-$RANDOM.json"
    echo '{}' > "$SKILL_CONFIG_PATH"
    export SKILL_CONFIG_PATH

    EMPTY_JOURNAL_DIR="$BATS_TMPDIR/empty-journal-$$-${BATS_TEST_NUMBER:-0}-$RANDOM"
    mkdir -p "$EMPTY_JOURNAL_DIR"

    EMPTY_MATRIX_DIR="$BATS_TMPDIR/empty-matrix-$$-${BATS_TEST_NUMBER:-0}-$RANDOM"
    mkdir -p "$EMPTY_MATRIX_DIR"

    BAD_MATRIX_DIR="$BATS_TMPDIR/bad-matrix-$$-${BATS_TEST_NUMBER:-0}-$RANDOM"
    mkdir -p "$BAD_MATRIX_DIR"
}

teardown() {
    rm -f "$SKILL_CONFIG_PATH"
    rm -rf "${EMPTY_JOURNAL_DIR:-}" "${EMPTY_MATRIX_DIR:-}" "${BAD_MATRIX_DIR:-}"
}

# ---------------------------------------------------------------------------
# (a) top-level schema + total_runs / trust_active_runs
# ---------------------------------------------------------------------------
@test "(a) output has schema==trust-receipts-report/v1, total_runs=6, trust_active_runs=5" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    schema=$(printf '%s\n' "$output" | jq -r '.schema')
    [ "$schema" = "trust-receipts-report/v1" ]

    for key in layer_status missing_receipt inconclusive effect_mismatch false_completion latency cost_proxy; do
        has=$(printf '%s\n' "$output" | jq --arg k "$key" 'has($k)')
        [ "$has" = "true" ]
    done

    total=$(printf '%s\n' "$output" | jq '.total_runs')
    [ "$total" -eq 6 ]

    active=$(printf '%s\n' "$output" | jq '.trust_active_runs')
    [ "$active" -eq 5 ]
}

# ---------------------------------------------------------------------------
# (b) layer_status distributions
# ---------------------------------------------------------------------------
@test "(b) layer_status verdict/reason distributions and stage breakdowns" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    sp_pass=$(printf '%s\n' "$output" | jq '[.layer_status.surfaceproof.verdict_reason[] | select(.verdict=="pass" and .reason_code=="OK")][0].count')
    [ "$sp_pass" -eq 4 ]
    sp_inconclusive=$(printf '%s\n' "$output" | jq '[.layer_status.surfaceproof.verdict_reason[] | select(.verdict=="inconclusive" and .reason_code=="PROBE_FAILED")][0].count')
    [ "$sp_inconclusive" -eq 1 ]
    sp_invalidated=$(printf '%s\n' "$output" | jq '.layer_status.surfaceproof.invalidated_count')
    [ "$sp_invalidated" -eq 0 ]

    es_pass=$(printf '%s\n' "$output" | jq '[.layer_status.evalseal.verdict_reason[] | select(.verdict=="pass")][0].count')
    [ "$es_pass" -eq 3 ]
    es_fail=$(printf '%s\n' "$output" | jq '[.layer_status.evalseal.verdict_reason[] | select(.verdict=="fail")][0].count')
    [ "$es_fail" -eq 1 ]
    es_stage=$(printf '%s\n' "$output" | jq '[.layer_status.evalseal.stages[] | select(.stage=="evaluate")][0].count')
    [ "$es_stage" -eq 4 ]

    ed_pass=$(printf '%s\n' "$output" | jq '[.layer_status.effectdelta.verdict_reason[] | select(.verdict=="pass")][0].count')
    [ "$ed_pass" -eq 4 ]
    ed_fail=$(printf '%s\n' "$output" | jq '[.layer_status.effectdelta.verdict_reason[] | select(.verdict=="fail")][0].count')
    [ "$ed_fail" -eq 1 ]
    ed_stage=$(printf '%s\n' "$output" | jq '[.layer_status.effectdelta.stages[] | select(.stage=="pr")][0].count')
    [ "$ed_stage" -eq 5 ]
}

# ---------------------------------------------------------------------------
# (c) missing_receipt (denominator=trust_active_runs=5)
# ---------------------------------------------------------------------------
@test "(c) missing_receipt: evalseal missing on run-002 only, overall_receipt_success_rate=0.8" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    denom=$(printf '%s\n' "$output" | jq '.missing_receipt.denominator')
    [ "$denom" -eq 5 ]

    sp_count=$(printf '%s\n' "$output" | jq '.missing_receipt.surfaceproof.count')
    [ "$sp_count" -eq 0 ]

    es_count=$(printf '%s\n' "$output" | jq '.missing_receipt.evalseal.count')
    [ "$es_count" -eq 1 ]
    es_rate=$(printf '%s\n' "$output" | jq '.missing_receipt.evalseal.rate')
    [ "$es_rate" = "0.2" ]
    es_runs=$(printf '%s\n' "$output" | jq -c '.missing_receipt.evalseal.runs')
    [ "$es_runs" = '["run-002"]' ]

    ed_count=$(printf '%s\n' "$output" | jq '.missing_receipt.effectdelta.count')
    [ "$ed_count" -eq 0 ]

    overall=$(printf '%s\n' "$output" | jq '.missing_receipt.overall_receipt_success_rate')
    [ "$overall" = "0.8" ]
}

# ---------------------------------------------------------------------------
# (d) inconclusive
# ---------------------------------------------------------------------------
@test "(d) inconclusive: run-003 surfaceproof PROBE_FAILED is the only hit" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    receipt_denom=$(printf '%s\n' "$output" | jq '.inconclusive.receipt_denominator')
    [ "$receipt_denom" -eq 14 ]
    receipt_count=$(printf '%s\n' "$output" | jq '.inconclusive.receipt_count')
    [ "$receipt_count" -eq 1 ]
    receipt_rate=$(printf '%s\n' "$output" | jq '.inconclusive.receipt_rate')
    expected_receipt_rate=$(jq -n '1/14')
    [ "$receipt_rate" = "$expected_receipt_rate" ]

    run_denom=$(printf '%s\n' "$output" | jq '.inconclusive.run_denominator')
    [ "$run_denom" -eq 5 ]
    run_count=$(printf '%s\n' "$output" | jq '.inconclusive.run_count')
    [ "$run_count" -eq 1 ]
    run_rate=$(printf '%s\n' "$output" | jq '.inconclusive.run_rate')
    [ "$run_rate" = "0.2" ]

    reason_dist=$(printf '%s\n' "$output" | jq -c '.inconclusive.reason_code_distribution')
    [ "$reason_dist" = '[{"reason_code":"PROBE_FAILED","count":1}]' ]

    runs=$(printf '%s\n' "$output" | jq -c '.inconclusive.runs')
    [ "$runs" = '["run-003"]' ]
}

# ---------------------------------------------------------------------------
# (e) effect_mismatch
# ---------------------------------------------------------------------------
@test "(e) effect_mismatch: run-004 DUPLICATE_EFFECT is the only hit" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    denom=$(printf '%s\n' "$output" | jq '.effect_mismatch.denominator')
    [ "$denom" -eq 5 ]
    count=$(printf '%s\n' "$output" | jq '.effect_mismatch.count')
    [ "$count" -eq 1 ]
    rate=$(printf '%s\n' "$output" | jq '.effect_mismatch.rate')
    [ "$rate" = "0.2" ]

    dup=$(printf '%s\n' "$output" | jq '[.effect_mismatch.domain_reason_code_distribution[] | select(.domain_reason_code=="DUPLICATE_EFFECT")][0].count')
    [ "$dup" -eq 1 ]
    ok=$(printf '%s\n' "$output" | jq '[.effect_mismatch.domain_reason_code_distribution[] | select(.domain_reason_code=="OK")][0].count')
    [ "$ok" -eq 4 ]

    runs=$(printf '%s\n' "$output" | jq -c '.effect_mismatch.runs')
    [ "$runs" = '["run-004"]' ]
}

# ---------------------------------------------------------------------------
# (f) false_completion
# ---------------------------------------------------------------------------
@test "(f) false_completion: run-004 (effectdelta fail) and run-005 (evalseal fail) both hit" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    denom=$(printf '%s\n' "$output" | jq '.false_completion.denominator')
    [ "$denom" -eq 5 ]
    count=$(printf '%s\n' "$output" | jq '.false_completion.count')
    [ "$count" -eq 2 ]
    rate=$(printf '%s\n' "$output" | jq '.false_completion.rate')
    [ "$rate" = "0.4" ]

    runs=$(printf '%s\n' "$output" | jq -c '.false_completion.runs')
    [ "$runs" = '["run-004","run-005"]' ]
}

# ---------------------------------------------------------------------------
# (g) latency (trust_active vs trust_inactive, added_p95)
# ---------------------------------------------------------------------------
@test "(g) latency: trust_active/trust_inactive duration_seconds + phase p50/p95 + added_p95" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    active_dur_count=$(printf '%s\n' "$output" | jq '.latency.trust_active.duration_seconds.count')
    [ "$active_dur_count" -eq 5 ]
    active_dur_p50=$(printf '%s\n' "$output" | jq '.latency.trust_active.duration_seconds.p50')
    [ "$active_dur_p50" = "1700" ]
    active_dur_p95=$(printf '%s\n' "$output" | jq '.latency.trust_active.duration_seconds.p95')
    [ "$active_dur_p95" = "1880" ]

    inactive_dur_count=$(printf '%s\n' "$output" | jq '.latency.trust_inactive.duration_seconds.count')
    [ "$inactive_dur_count" -eq 1 ]
    inactive_dur_p50=$(printf '%s\n' "$output" | jq '.latency.trust_inactive.duration_seconds.p50')
    [ "$inactive_dur_p50" = "1000" ]
    inactive_dur_p95=$(printf '%s\n' "$output" | jq '.latency.trust_inactive.duration_seconds.p95')
    [ "$inactive_dur_p95" = "1000" ]

    active_eval_p50=$(printf '%s\n' "$output" | jq '.latency.trust_active.phase_durations.evaluate.p50')
    [ "$active_eval_p50" = "120" ]
    active_eval_p95=$(printf '%s\n' "$output" | jq '.latency.trust_active.phase_durations.evaluate.p95')
    [ "$active_eval_p95" = "138" ]

    added_p95=$(printf '%s\n' "$output" | jq '.latency.trust_added_p95_seconds')
    [ "$added_p95" = "880" ]
}

# ---------------------------------------------------------------------------
# (h) cost_proxy
# ---------------------------------------------------------------------------
@test "(h) cost_proxy: receipt-count-per-run p50/p95 + note" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    count=$(printf '%s\n' "$output" | jq '.cost_proxy.count')
    [ "$count" -eq 5 ]
    p50=$(printf '%s\n' "$output" | jq '.cost_proxy.p50')
    [ "$p50" = "3" ]
    p95=$(printf '%s\n' "$output" | jq '.cost_proxy.p95')
    [ "$p95" = "3" ]
    note=$(printf '%s\n' "$output" | jq -r '.cost_proxy.note')
    [ -n "$note" ] && [ "$note" != "null" ]
}

# ---------------------------------------------------------------------------
# (i) empty journal -> exit 0, all counts 0 / rates null (AC-13 0-run safety)
# ---------------------------------------------------------------------------
@test "(i) empty journal -> exit 0, total_runs=0, trust_active_runs=0, rates null" {
    run env CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL_DIR" bash "$SCRIPT_PATH" --window 30d
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_runs')
    [ "$total" -eq 0 ]
    active=$(printf '%s\n' "$output" | jq '.trust_active_runs')
    [ "$active" -eq 0 ]

    es_rate=$(printf '%s\n' "$output" | jq '.missing_receipt.evalseal.rate')
    [ "$es_rate" = "null" ]
    overall=$(printf '%s\n' "$output" | jq '.missing_receipt.overall_receipt_success_rate')
    [ "$overall" = "null" ]

    inc_rate=$(printf '%s\n' "$output" | jq '.inconclusive.run_rate')
    [ "$inc_rate" = "null" ]
    em_rate=$(printf '%s\n' "$output" | jq '.effect_mismatch.rate')
    [ "$em_rate" = "null" ]
    fc_rate=$(printf '%s\n' "$output" | jq '.false_completion.rate')
    [ "$fc_rate" = "null" ]

    added_p95=$(printf '%s\n' "$output" | jq '.latency.trust_added_p95_seconds')
    [ "$added_p95" = "null" ]

    cp_p50=$(printf '%s\n' "$output" | jq '.cost_proxy.p50')
    [ "$cp_p50" = "null" ]
}

# ---------------------------------------------------------------------------
# (j) --slo: base fixtures (5 eligible < 20) -> no-go / INSUFFICIENT_RUNS + others
# ---------------------------------------------------------------------------
@test "(j) --slo on base fixtures: eligible_runs=5 -> go_no_go=no-go with reasons" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL" --slo
    [ "$status" -eq 0 ]

    eligible=$(printf '%s\n' "$output" | jq '.slo.eligible_runs')
    [ "$eligible" -eq 5 ]
    min_runs=$(printf '%s\n' "$output" | jq '.slo.min_runs')
    [ "$min_runs" -eq 20 ]

    go=$(printf '%s\n' "$output" | jq -r '.slo.go_no_go')
    [ "$go" = "no-go" ]

    reasons=$(printf '%s\n' "$output" | jq -c '.slo.reasons | sort')
    [ "$reasons" = '["INCONCLUSIVE_ABOVE_SLO","INSUFFICIENT_RUNS","LATENCY_P95_ABOVE_SLO","RECEIPT_SUCCESS_BELOW_SLO"]' ]
}

# ---------------------------------------------------------------------------
# (k) --slo on empty journal: unmeasurable latency -> LATENCY_UNMEASURABLE
# ---------------------------------------------------------------------------
@test "(k) --slo on empty journal: INSUFFICIENT_RUNS + LATENCY_UNMEASURABLE, go_no_go=no-go" {
    run env CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL_DIR" bash "$SCRIPT_PATH" --window 30d --slo
    [ "$status" -eq 0 ]

    go=$(printf '%s\n' "$output" | jq -r '.slo.go_no_go')
    [ "$go" = "no-go" ]
    reasons=$(printf '%s\n' "$output" | jq -c '.slo.reasons | sort')
    [ "$reasons" = '["INSUFFICIENT_RUNS","LATENCY_UNMEASURABLE"]' ]
}

# ---------------------------------------------------------------------------
# (l) without --slo, slo key is absent
# ---------------------------------------------------------------------------
@test "(l) without --slo flag, .slo key is absent" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]
    has=$(printf '%s\n' "$output" | jq 'has("slo")')
    [ "$has" = "false" ]
}

# ---------------------------------------------------------------------------
# (m) unknown argument -> exit 1, JSON error
# ---------------------------------------------------------------------------
@test "(m) unknown argument -> exit 1, JSON error" {
    run env CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL_DIR" bash "$SCRIPT_PATH" --bogus-flag
    [ "$status" -eq 1 ]
    printf '%s\n' "$output" | jq -e '.status == "error"'
}

# ---------------------------------------------------------------------------
# (n) --matrix with out-of-enum fixture_axis -> exit 1, JSON error
# ---------------------------------------------------------------------------
@test "(n) --matrix out-of-enum fixture_axis -> exit 1, JSON error" {
    cat > "$BAD_MATRIX_DIR/01-bad-axis.json" <<'EOF'
{
  "version": "1.0.0",
  "id": "matrix-bad-axis",
  "timestamp": "2026-01-10T00:00:00Z",
  "skill": "dev-flow",
  "outcome": "success",
  "source": "skill",
  "context": {
    "fixture_axis": "not-a-real-axis",
    "layer_modes": { "surfaceproof": "off", "evalseal": "off", "effectdelta": "off" }
  },
  "telemetry": { "eval_verdict": "pass", "duration_seconds": 100 }
}
EOF
    run bash "$SCRIPT_PATH" --matrix "$BAD_MATRIX_DIR"
    [ "$status" -eq 1 ]
    printf '%s\n' "$output" | jq -e '.status == "error"'
}

# ---------------------------------------------------------------------------
# (o) --matrix with out-of-enum layer_modes value -> exit 1, JSON error
# ---------------------------------------------------------------------------
@test "(o) --matrix out-of-enum layer_modes value -> exit 1, JSON error" {
    cat > "$BAD_MATRIX_DIR/01-bad-mode.json" <<'EOF'
{
  "version": "1.0.0",
  "id": "matrix-bad-mode",
  "timestamp": "2026-01-10T00:00:00Z",
  "skill": "dev-flow",
  "outcome": "success",
  "source": "skill",
  "context": {
    "fixture_axis": "coding",
    "layer_modes": { "surfaceproof": "blocking", "evalseal": "off", "effectdelta": "off" }
  },
  "telemetry": { "eval_verdict": "pass", "duration_seconds": 100 }
}
EOF
    run bash "$SCRIPT_PATH" --matrix "$BAD_MATRIX_DIR"
    [ "$status" -eq 1 ]
    printf '%s\n' "$output" | jq -e '.status == "error"'
}

# ---------------------------------------------------------------------------
# (p) --matrix empty dir -> exit 0, 32 zero-filled cells (4 axes x 8 mode combos)
# ---------------------------------------------------------------------------
@test "(p) --matrix empty dir -> exit 0, schema + 32 zero-filled cells" {
    run bash "$SCRIPT_PATH" --matrix "$EMPTY_MATRIX_DIR"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    schema=$(printf '%s\n' "$output" | jq -r '.schema')
    [ "$schema" = "trust-receipts-matrix/v1" ]

    cell_count=$(printf '%s\n' "$output" | jq '.cells | length')
    [ "$cell_count" -eq 32 ]

    all_zero=$(printf '%s\n' "$output" | jq '[.cells[].run_count] | add')
    [ "$all_zero" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (q) --matrix with one valid fixture -> that cell has run_count=1
# ---------------------------------------------------------------------------
@test "(q) --matrix with one valid fixture -> matching cell run_count=1, false_completion/inconclusive counted" {
    VALID_MATRIX_DIR="$BATS_TMPDIR/valid-matrix-$$-$RANDOM"
    mkdir -p "$VALID_MATRIX_DIR"
    cat > "$VALID_MATRIX_DIR/01-e2e-all-shadow.json" <<'EOF'
{
  "version": "1.0.0",
  "id": "matrix-e2e-01",
  "timestamp": "2026-01-10T00:00:00Z",
  "skill": "dev-flow",
  "outcome": "success",
  "source": "skill",
  "context": {
    "fixture_axis": "e2e",
    "layer_modes": { "surfaceproof": "shadow", "evalseal": "shadow", "effectdelta": "shadow" }
  },
  "telemetry": {
    "eval_verdict": "pass",
    "duration_seconds": 500,
    "trust_run_id": "matrix-run-01",
    "trust_surfaceproof_shadow": { "mode": "shadow", "verdict": "pass", "reason_code": "OK", "receipt_id": "sha256:m1" },
    "trust_receipts": []
  }
}
EOF
    run bash "$SCRIPT_PATH" --matrix "$VALID_MATRIX_DIR"
    [ "$status" -eq 0 ]

    cell=$(printf '%s\n' "$output" | jq -c '[.cells[] | select(.axis=="e2e" and .layer_modes.surfaceproof=="shadow" and .layer_modes.evalseal=="shadow" and .layer_modes.effectdelta=="shadow")][0]')
    run_count=$(printf '%s\n' "$cell" | jq '.run_count')
    [ "$run_count" -eq 1 ]
    fc_count=$(printf '%s\n' "$cell" | jq '.false_completion_count')
    [ "$fc_count" -eq 0 ]
    duration_p50=$(printf '%s\n' "$cell" | jq '.duration_p50')
    [ "$duration_p50" = "500" ]

    rm -rf "$VALID_MATRIX_DIR"
}

# ---------------------------------------------------------------------------
# (r) determinism: same fixtures + same --until run twice -> byte-identical
#     stdout (excluding taken_at).
# ---------------------------------------------------------------------------
@test "(r) two runs against same fixtures are byte-identical modulo taken_at" {
    OUT1="$BATS_TMPDIR/trust-receipts-run1-$$.json"
    OUT2="$BATS_TMPDIR/trust-receipts-run2-$$.json"

    env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL" \
        | jq -S 'del(.taken_at)' > "$OUT1"
    env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL" \
        | jq -S 'del(.taken_at)' > "$OUT2"

    run diff "$OUT1" "$OUT2"
    [ "$status" -eq 0 ]

    rm -f "$OUT1" "$OUT2"
}
