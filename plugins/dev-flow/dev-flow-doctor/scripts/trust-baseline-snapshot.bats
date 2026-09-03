#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/trust-baseline-snapshot.sh
#
# Aggregates existing dev-flow journal telemetry into 4 re-runnable trust-layer
# baseline proxies (issue #390 Phase 0):
#   1. false_completion_proxy  - eval_verdict=="pass" だが final_ac_reconcile /
#      testsurf_hits / redgreen_deny が完了を疑わせる run
#   2. inconclusive_events     - eval_staleness / final_reconcile / vdelta_fail_open /
#      ui_verify が inconclusive を示す run
#   3. phase_latency           - phase_durations(8 phase) + duration_seconds の
#      count/p50/p95
#   4. effect_failure_rate     - iterate_status が fix_failed|stuck の割合
#
# Fixture journal (dev-flow-doctor/tests/fixtures/trust-baseline/*.json) は
# committed static entries -- 全 16 件、2026-01-10 〜 2026-01-25 の timestamp。
# --until 2026-02-01T00:00:00Z --window 30d で since=2026-01-02T00:00:00Z
# となり、全 fixture が window に入る（"now" 非依存で決定論）。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/trust-baseline-snapshot.sh"
FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")/../tests/fixtures/trust-baseline" && pwd)"

UNTIL="2026-02-01T00:00:00Z"

setup() {
    SKILL_CONFIG_PATH="$BATS_TMPDIR/cfg-$$-${BATS_TEST_NUMBER:-0}-$RANDOM.json"
    echo '{}' > "$SKILL_CONFIG_PATH"
    export SKILL_CONFIG_PATH

    EMPTY_JOURNAL_DIR="$BATS_TMPDIR/empty-journal-$$-${BATS_TEST_NUMBER:-0}-$RANDOM"
    mkdir -p "$EMPTY_JOURNAL_DIR"
}

teardown() {
    rm -f "$SKILL_CONFIG_PATH"
    rm -rf "${EMPTY_JOURNAL_DIR:-}"
}

# ---------------------------------------------------------------------------
# (a) top-level schema + 4 proxy keys present
# ---------------------------------------------------------------------------
@test "(a) output has schema==trust-layer-baseline/v1 and 4 proxy keys" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    schema=$(printf '%s\n' "$output" | jq -r '.schema')
    [ "$schema" = "trust-layer-baseline/v1" ]

    version=$(printf '%s\n' "$output" | jq -r '.version')
    [ -n "$version" ] && [ "$version" != "null" ]

    for key in false_completion_proxy inconclusive_events phase_latency effect_failure_rate; do
        has=$(printf '%s\n' "$output" | jq --arg k "$key" 'has($k)')
        [ "$has" = "true" ]
    done

    total=$(printf '%s\n' "$output" | jq '.total_runs')
    [ "$total" -eq 16 ]
}

# ---------------------------------------------------------------------------
# (b) planted false-completion / inconclusive / effect-failure counts
# ---------------------------------------------------------------------------
@test "(b) false_completion_proxy counts planted hits correctly" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    # eval_verdict=="pass": entries 1,2,3,4 (4 total). Hits: 2 (final_ac_reconcile
    # unavailable), 3 (testsurf_hits nonempty), 4 (redgreen_deny nonempty) = 3.
    count=$(printf '%s\n' "$output" | jq '.false_completion_proxy.count')
    [ "$count" -eq 3 ]

    denom=$(printf '%s\n' "$output" | jq '.false_completion_proxy.denominator')
    [ "$denom" -eq 16 ]

    rate=$(printf '%s\n' "$output" | jq '.false_completion_proxy.rate')
    [ "$rate" = "0.1875" ]

    # entry 5 has eval_verdict=="fail" -- must NOT be counted even though it
    # also has final_ac_reconcile=="unavailable" and testsurf_hits nonempty.
    ac_count=$(printf '%s\n' "$output" | jq '.false_completion_proxy.checks.final_ac_reconcile_unavailable.count')
    [ "$ac_count" -eq 1 ]
    ac_denom=$(printf '%s\n' "$output" | jq '.false_completion_proxy.checks.final_ac_reconcile_unavailable.denominator')
    [ "$ac_denom" -eq 4 ]

    ts_count=$(printf '%s\n' "$output" | jq '.false_completion_proxy.checks.testsurf_hits_nonempty.count')
    [ "$ts_count" -eq 1 ]
    ts_denom=$(printf '%s\n' "$output" | jq '.false_completion_proxy.checks.testsurf_hits_nonempty.denominator')
    [ "$ts_denom" -eq 4 ]

    rd_count=$(printf '%s\n' "$output" | jq '.false_completion_proxy.checks.redgreen_deny_nonempty.count')
    [ "$rd_count" -eq 1 ]
    rd_denom=$(printf '%s\n' "$output" | jq '.false_completion_proxy.checks.redgreen_deny_nonempty.denominator')
    [ "$rd_denom" -eq 1 ]
}

@test "(b) inconclusive_events counts planted hits correctly" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    # Distinct runs hitting >=1 of 4 conditions: staleness(7) + reconcile(8) +
    # vdelta(9) + ui(10,11) = 5 runs.
    count=$(printf '%s\n' "$output" | jq '.inconclusive_events.count')
    [ "$count" -eq 5 ]
    denom=$(printf '%s\n' "$output" | jq '.inconclusive_events.denominator')
    [ "$denom" -eq 16 ]
    rate=$(printf '%s\n' "$output" | jq '.inconclusive_events.rate')
    [ "$rate" = "0.3125" ]

    stale_count=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.eval_staleness_inconclusive.count')
    [ "$stale_count" -eq 1 ]
    stale_denom=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.eval_staleness_inconclusive.denominator')
    [ "$stale_denom" -eq 5 ]

    reconcile_count=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.final_reconcile_unavailable.count')
    [ "$reconcile_count" -eq 1 ]
    reconcile_denom=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.final_reconcile_unavailable.denominator')
    [ "$reconcile_denom" -eq 5 ]

    vdelta_count=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.vdelta_fail_open_positive.count')
    [ "$vdelta_count" -eq 1 ]
    vdelta_denom=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.vdelta_fail_open_positive.denominator')
    [ "$vdelta_denom" -eq 3 ]

    ui_count=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.ui_verify_inconclusive.count')
    [ "$ui_count" -eq 2 ]
    ui_denom=$(printf '%s\n' "$output" | jq '.inconclusive_events.checks.ui_verify_inconclusive.denominator')
    [ "$ui_denom" -eq 6 ]
}

@test "(b) effect_failure_rate counts planted fix_failed/stuck correctly" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    # iterate_status present on entries 1(lgtm), 12(fix_failed), 13(stuck), 14(lgtm) = 4.
    denom=$(printf '%s\n' "$output" | jq '.effect_failure_rate.denominator')
    [ "$denom" -eq 4 ]
    count=$(printf '%s\n' "$output" | jq '.effect_failure_rate.count')
    [ "$count" -eq 2 ]
    rate=$(printf '%s\n' "$output" | jq '.effect_failure_rate.rate')
    [ "$rate" = "0.5" ]
}

# ---------------------------------------------------------------------------
# (c) phase_latency p50/p95 match known fixture values
# ---------------------------------------------------------------------------
@test "(c) phase_latency p50/p95 match known 2-value fixture set" {
    run env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL"
    [ "$status" -eq 0 ]

    for phase in analyze plan implement validate evaluate pr iterate final; do
        cnt=$(printf '%s\n' "$output" | jq --arg p "$phase" '.phase_latency[$p].count')
        [ "$cnt" -eq 2 ]
        p50=$(printf '%s\n' "$output" | jq --arg p "$phase" '.phase_latency[$p].p50')
        [ "$p50" = "150" ]
        p95=$(printf '%s\n' "$output" | jq --arg p "$phase" '.phase_latency[$p].p95')
        [ "$p95" = "195" ]
    done

    dur_cnt=$(printf '%s\n' "$output" | jq '.phase_latency.duration_seconds.count')
    [ "$dur_cnt" -eq 2 ]
    dur_p50=$(printf '%s\n' "$output" | jq '.phase_latency.duration_seconds.p50')
    [ "$dur_p50" = "1500" ]
    dur_p95=$(printf '%s\n' "$output" | jq '.phase_latency.duration_seconds.p95')
    [ "$dur_p95" = "1950" ]
}

# ---------------------------------------------------------------------------
# (d) empty journal -> exit 0, total_runs==0, all counts 0, percentiles null
# ---------------------------------------------------------------------------
@test "(d) empty journal -> exit 0, total_runs==0, percentiles null" {
    run env CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL_DIR" "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_runs')
    [ "$total" -eq 0 ]

    fc_count=$(printf '%s\n' "$output" | jq '.false_completion_proxy.count')
    [ "$fc_count" -eq 0 ]
    fc_rate=$(printf '%s\n' "$output" | jq '.false_completion_proxy.rate')
    [ "$fc_rate" = "null" ]

    ie_rate=$(printf '%s\n' "$output" | jq '.inconclusive_events.rate')
    [ "$ie_rate" = "null" ]

    efr_denom=$(printf '%s\n' "$output" | jq '.effect_failure_rate.denominator')
    [ "$efr_denom" -eq 0 ]
    efr_rate=$(printf '%s\n' "$output" | jq '.effect_failure_rate.rate')
    [ "$efr_rate" = "null" ]

    p50=$(printf '%s\n' "$output" | jq '.phase_latency.analyze.p50')
    [ "$p50" = "null" ]
    dur_p95=$(printf '%s\n' "$output" | jq '.phase_latency.duration_seconds.p95')
    [ "$dur_p95" = "null" ]
}

# ---------------------------------------------------------------------------
# (e) unknown argument -> exit 1, JSON error
# ---------------------------------------------------------------------------
@test "(e) unknown argument -> exit 1, JSON error" {
    run env CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL_DIR" "$SCRIPT" --bogus-flag

    [ "$status" -eq 1 ]
    printf '%s\n' "$output" | jq -e '.status == "error"'
}

# ---------------------------------------------------------------------------
# (f) determinism: same fixtures + same --until run twice -> byte-identical
#     stdout (excluding taken_at, which is wall-clock and legitimately varies).
# ---------------------------------------------------------------------------
@test "(f) two runs against same fixtures are byte-identical modulo taken_at" {
    OUT1="$BATS_TMPDIR/trust-baseline-run1-$$.json"
    OUT2="$BATS_TMPDIR/trust-baseline-run2-$$.json"

    env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL" \
        | jq -S 'del(.taken_at)' > "$OUT1"
    env CLAUDE_JOURNAL_DIR="$FIXTURES" "$SCRIPT" --window 30d --until "$UNTIL" \
        | jq -S 'del(.taken_at)' > "$OUT2"

    run diff "$OUT1" "$OUT2"
    [ "$status" -eq 0 ]

    rm -f "$OUT1" "$OUT2"
}
