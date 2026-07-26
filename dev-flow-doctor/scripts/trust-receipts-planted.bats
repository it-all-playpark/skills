#!/usr/bin/env bats
# Planted-corpus recall test for dev-flow-doctor/scripts/trust-receipts-report.sh
# (epic #390 Phase 5, issue #413, AC-14).
#
# Fixtures: dev-flow-doctor/tests/fixtures/trust-receipts/planted/*.json — 7 planted
# failure runs (one per detection category exercised by trust-receipts-report.sh) + 3
# clean runs (all 3 layers pass, no contradictions). Every planted run id MUST appear
# in its expected category's `runs` array (recall 100%, checked per-id — a single
# miss fails the test) and every clean run id MUST NOT appear in ANY detection
# category's `runs` array (false positive == 0).
#
# Planted run -> expected category:
#   planted-omission         -> missing_receipt.evalseal.runs   (evalseal receipt absent)
#   planted-tamper           -> false_completion.runs           (evalseal fail + eval_verdict==pass)
#   planted-stale-sha        -> inconclusive.runs               (final-stage inconclusive;
#                                also asserts the invalidated evaluate-stage fail receipt
#                                does NOT leak into false_completion.runs)
#   planted-response-loss    -> inconclusive.runs               (also asserts RESPONSE_LOST
#                                appears in effect_mismatch.domain_reason_code_distribution)
#   planted-duplicate        -> effect_mismatch.runs            (DUPLICATE_EFFECT)
#   planted-partial-effect   -> effect_mismatch.runs            (WRONG_TARGET on summary-comment stage)
#   planted-observer-timeout -> inconclusive.runs               (PROBE_FAILED)

SCRIPT_PATH="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/trust-receipts-report.sh"
FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")/../tests/fixtures/trust-receipts/planted" && pwd)"

UNTIL="2026-02-01T00:00:00Z"

setup() {
    OUTPUT_JSON="$BATS_TMPDIR/trust-receipts-planted-$$-${BATS_TEST_NUMBER:-0}-$RANDOM.json"
    env CLAUDE_JOURNAL_DIR="$FIXTURES" bash "$SCRIPT_PATH" --window 30d --until "$UNTIL" > "$OUTPUT_JSON"
}

teardown() {
    rm -f "${OUTPUT_JSON:-}"
}

@test "(a) report runs cleanly against the planted corpus (schema + counts)" {
    jq empty "$OUTPUT_JSON"

    schema=$(jq -r '.schema' "$OUTPUT_JSON")
    [ "$schema" = "trust-receipts-report/v1" ]

    total=$(jq '.total_runs' "$OUTPUT_JSON")
    [ "$total" -eq 10 ]

    active=$(jq '.trust_active_runs' "$OUTPUT_JSON")
    [ "$active" -eq 10 ]
}

# ---------------------------------------------------------------------------
# (b) recall 100%: every planted run id must appear in its expected category's
# runs array. Checked per-id (id-level, not rate) so a single miss fails.
# ---------------------------------------------------------------------------
@test "(b) planted failure recall 100%: every planted run id is caught in its expected category" {
    declare -A expected=(
        [planted-omission]="missing_receipt.evalseal.runs"
        [planted-tamper]="false_completion.runs"
        [planted-stale-sha]="inconclusive.runs"
        [planted-response-loss]="inconclusive.runs"
        [planted-duplicate]="effect_mismatch.runs"
        [planted-partial-effect]="effect_mismatch.runs"
        [planted-observer-timeout]="inconclusive.runs"
    )

    missed=""
    for run_id in "${!expected[@]}"; do
        path="${expected[$run_id]}"
        hit=$(jq --arg id "$run_id" "[.${path}[] | select(. == \$id)] | length" "$OUTPUT_JSON")
        if [ "$hit" -lt 1 ]; then
            missed="$missed $run_id(.${path})"
        fi
    done

    if [ -n "$missed" ]; then
        echo "missed planted runs:$missed" >&2
        echo "full report: $(cat "$OUTPUT_JSON")" >&2
    fi
    [ -z "$missed" ]
}

# ---------------------------------------------------------------------------
# (c) planted-stale-sha: invalidated evaluate-stage fail receipt must not leak
# into false_completion.runs (invalidated exclusion from verdict aggregation).
# ---------------------------------------------------------------------------
@test "(c) planted-stale-sha: invalidated receipt excluded from false_completion" {
    hit=$(jq '[.false_completion.runs[] | select(. == "planted-stale-sha")] | length' "$OUTPUT_JSON")
    [ "$hit" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (d) planted-response-loss: RESPONSE_LOST domain_reason_code is present in the
# effect_mismatch domain_reason_code distribution (observation, not necessarily
# a mismatch hit since verdict is inconclusive, not fail).
# ---------------------------------------------------------------------------
@test "(d) planted-response-loss: RESPONSE_LOST present in effect_mismatch.domain_reason_code_distribution" {
    count=$(jq '[.effect_mismatch.domain_reason_code_distribution[] | select(.domain_reason_code=="RESPONSE_LOST")][0].count' "$OUTPUT_JSON")
    [ "$count" -ge 1 ]
}

# ---------------------------------------------------------------------------
# (e) false positive == 0: clean run ids never appear in any detection category.
# ---------------------------------------------------------------------------
@test "(e) clean runs (3) never appear in any detection category's runs array" {
    for run_id in clean-01 clean-02 clean-03; do
        for path in missing_receipt.surfaceproof.runs missing_receipt.evalseal.runs missing_receipt.effectdelta.runs \
                    inconclusive.runs effect_mismatch.runs false_completion.runs; do
            hit=$(jq --arg id "$run_id" "[.${path}[] | select(. == \$id)] | length" "$OUTPUT_JSON")
            [ "$hit" -eq 0 ]
        done
    done
}
