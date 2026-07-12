#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh
#
# Focus: dev-flow / pr-iterate journal telemetry 分布集計 + anomaly 3 種判定
# (cap_pinned / iterate_unhealthy / micro_nonfiring)。
#
# 全 fixture は setup() 内で相対日付生成（macOS -v / GNU -d 両対応）し、
# CLAUDE_JOURNAL_DIR は都度隔離、SKILL_CONFIG_PATH は既定 {} で config leak を防ぐ。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/analyze-dev-flow-telemetry.sh"

setup() {
    CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$-${BATS_TEST_NUMBER:-0}-$RANDOM"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
    export CLAUDE_JOURNAL_DIR

    SKILL_CONFIG_PATH="$BATS_TMPDIR/cfg-$$-${BATS_TEST_NUMBER:-0}-$RANDOM.json"
    echo '{}' > "$SKILL_CONFIG_PATH"
    export SKILL_CONFIG_PATH

    # 1 日前の相対タイムスタンプ (macOS -v / GNU -d 両対応)
    TS="$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)"
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
    rm -f "$SKILL_CONFIG_PATH"
}

# Compute an ISO-8601 UTC timestamp offset from a base ISO timestamp by N
# seconds (may be negative). macOS (BSD date) and GNU date compatible.
iso_offset() {
    local base="$1" offset_secs="$2"
    local epoch
    epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$base" "+%s" 2>/dev/null \
        || date -u -d "$base" "+%s")
    epoch=$((epoch + offset_secs))
    date -u -r "$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u -d "@${epoch}" "+%Y-%m-%dT%H:%M:%SZ"
}

# Write one dev-flow journal entry with the given telemetry JSON object.
# $1 = filename, $2 = telemetry JSON (compact), $3 = optional id override,
# $4 = optional repo (e.g. "acme/skills"), $5 = optional pr_number,
# $6 = optional timestamp override (defaults to $TS). $4/$5/$6 are additive:
# existing 3-arg callers are unaffected (no "context" key emitted unless both
# repo and pr_number are given).
write_devflow_entry() {
    local fname="$1" telemetry="$2" id="${3:-$RANDOM}" repo="${4:-}" pr_number="${5:-}" ts="${6:-$TS}"
    local context_json=""
    if [[ -n "$repo" && -n "$pr_number" ]]; then
        context_json=",
  \"context\": { \"repo\": \"${repo}\", \"pr_number\": ${pr_number} }"
    fi
    cat > "${CLAUDE_JOURNAL_DIR}/${fname}" <<EOF
{
  "version": "1.0.0",
  "id": "devflow-${id}",
  "timestamp": "${ts}",
  "skill": "dev-flow",
  "outcome": "success",
  "source": "skill",
  "telemetry": ${telemetry}${context_json}
}
EOF
}

# Write one pr-iterate standalone journal entry.
# $1 = filename, $2 = iterate_status value, $3 = optional id override,
# $4 = optional repo, $5 = optional pr_number, $6 = optional timestamp override
# (defaults to $TS). Additive, same backward-compat contract as
# write_devflow_entry above.
write_priterate_entry() {
    local fname="$1" status="$2" id="${3:-$RANDOM}" repo="${4:-}" pr_number="${5:-}" ts="${6:-$TS}"
    local context_json=""
    if [[ -n "$repo" && -n "$pr_number" ]]; then
        context_json=",
  \"context\": { \"repo\": \"${repo}\", \"pr_number\": ${pr_number} }"
    fi
    cat > "${CLAUDE_JOURNAL_DIR}/${fname}" <<EOF
{
  "version": "1.0.0",
  "id": "priterate-${id}",
  "timestamp": "${ts}",
  "skill": "pr-iterate",
  "outcome": "success",
  "source": "skill",
  "telemetry": { "merge_tier": "PR_ITERATE", "iterate_status": "${status}" }${context_json}
}
EOF
}

# Write one hook-capture journal entry (source="hook", no telemetry).
# Mimics journal.sh cmd_hook_capture output on PostToolUseFailure: skill is
# attributed to the active skill (e.g. "dev-flow") but source=="hook" and no
# telemetry key is present.
# $1 = filename, $2 = optional id override
write_hook_entry() {
    local fname="$1" id="${2:-$RANDOM}"
    cat > "${CLAUDE_JOURNAL_DIR}/${fname}" <<EOF
{
  "version": "1.0.0",
  "id": "hook-${id}",
  "timestamp": "${TS}",
  "skill": "dev-flow",
  "outcome": "failure",
  "source": "hook",
  "error": { "category": "runtime", "message": "tool failed" }
}
EOF
}

# ---------------------------------------------------------------------------
# Test 1: empty journal -> exit 0, valid JSON, total_dev_flow_runs==0,
#         micro_nonfiring severity=skipped
# ---------------------------------------------------------------------------
@test "empty journal -> exit 0, total_dev_flow_runs==0, micro_nonfiring skipped" {
    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 0 ]

    severity=$(printf '%s\n' "$output" | jq -r '[.anomalies[] | select(.type=="micro_nonfiring")][0].severity')
    [ "$severity" = "skipped" ]
}

# ---------------------------------------------------------------------------
# Test 2: shape distribution counts
# ---------------------------------------------------------------------------
@test "shape distribution: micro/standard/complex mix counted correctly" {
    write_devflow_entry "e1.json" '{"shape":"micro","merge_tier":"AUTO","plan_iter":1,"eval_iter":0}' 1
    write_devflow_entry "e2.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' 2
    write_devflow_entry "e3.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' 3
    write_devflow_entry "e4.json" '{"shape":"complex","merge_tier":"HOLD","plan_iter":3,"eval_iter":2}' 4

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    micro=$(printf '%s\n' "$output" | jq '.distributions.shape.micro')
    standard=$(printf '%s\n' "$output" | jq '.distributions.shape.standard')
    complex=$(printf '%s\n' "$output" | jq '.distributions.shape.complex')
    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')

    [ "$micro" -eq 1 ]
    [ "$standard" -eq 2 ]
    [ "$complex" -eq 1 ]
    [ "$total" -eq 4 ]
}

# ---------------------------------------------------------------------------
# Test 3: cap張り付き (eval_iter at cap) -> anomaly cap_pinned warn
# ---------------------------------------------------------------------------
@test "cap-pinned: eval_iter==eval_iter_cap(10) -> anomaly cap_pinned warn" {
    write_devflow_entry "e1.json" '{"shape":"complex","merge_tier":"REVIEW","plan_iter":2,"eval_iter":10}' 1

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="cap_pinned" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test 4: micro不発火 (11 dev-flow runs, 0 micro) -> anomaly micro_nonfiring warn
# ---------------------------------------------------------------------------
@test "micro-nonfiring: 11 dev-flow runs with 0 micro -> anomaly warn" {
    local i
    for i in $(seq 1 6); do
        write_devflow_entry "standard-${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' "s${i}"
    done
    for i in $(seq 1 5); do
        write_devflow_entry "complex-${i}.json" '{"shape":"complex","merge_tier":"HOLD","plan_iter":2,"eval_iter":2}' "c${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 11 ]

    severity=$(printf '%s\n' "$output" | jq -r '[.anomalies[] | select(.type=="micro_nonfiring")][0].severity')
    [ "$severity" = "warn" ]
}

# ---------------------------------------------------------------------------
# Test 5: micro判定skip (5 dev-flow runs, 0 micro) -> severity=skipped
# ---------------------------------------------------------------------------
@test "micro-nonfiring judgement skip: 5 dev-flow runs with 0 micro -> severity skipped" {
    local i
    for i in $(seq 1 5); do
        write_devflow_entry "standard-${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' "s${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 5 ]

    severity=$(printf '%s\n' "$output" | jq -r '[.anomalies[] | select(.type=="micro_nonfiring")][0].severity')
    [ "$severity" = "skipped" ]
}

# ---------------------------------------------------------------------------
# Test 6a: iterate不調 (lgtm x3 + stuck x2 + fix_failed x2, 4/7 ~= 57% > 30%) -> warn
# ---------------------------------------------------------------------------
@test "iterate-unhealthy: 4/7 non-lgtm (~57%) -> anomaly iterate_unhealthy warn" {
    local i
    for i in 1 2 3; do
        write_devflow_entry "lgtm-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"lgtm\"}" "l${i}"
    done
    for i in 1 2; do
        write_devflow_entry "stuck-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"stuck\"}" "st${i}"
    done
    for i in 1 2; do
        write_devflow_entry "fixfail-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"fix_failed\"}" "ff${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test 6b: iterate正常 (lgtm x9 + stuck x1, 10%) -> no anomaly
# ---------------------------------------------------------------------------
@test "iterate-healthy: 1/10 non-lgtm (10%) -> no iterate_unhealthy anomaly" {
    local i
    for i in $(seq 1 9); do
        write_devflow_entry "lgtm-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"lgtm\"}" "l${i}"
    done
    write_devflow_entry "stuck-1.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"stuck\"}" "st1"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy")] | length')
    [ "$found" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 7: PR_ITERATE 混在 corpus -> merge_tier 分布に PR_ITERATE キーが現れない
#          (denominator 分離)。iterate_status 分布には pr-iterate の lgtm が
#          計上される。
# ---------------------------------------------------------------------------
@test "PR_ITERATE entries excluded from merge_tier distribution but counted in iterate_status" {
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' 1
    write_priterate_entry "pri1.json" "lgtm" 1

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    # merge_tier distribution must not have a PR_ITERATE key
    has_pr_iterate_key=$(printf '%s\n' "$output" | jq 'has("distributions") and (.distributions.merge_tier | has("PR_ITERATE"))')
    [ "$has_pr_iterate_key" = "false" ]

    # total_dev_flow_runs must only count the dev-flow entry
    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 1 ]

    # iterate_status distribution must count both entries (dev-flow + pr-iterate)
    iterate_total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    [ "$iterate_total" -eq 2 ]
    lgtm_count=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.lgtm')
    [ "$lgtm_count" -eq 2 ]
}

# ---------------------------------------------------------------------------
# Test 8: 閾値外出し -- SKILL_CONFIG_PATH に eval_iter_cap=5 を書いた config で
#          eval_iter=6 が cap_pinned を起こす (config 反映確認)
# ---------------------------------------------------------------------------
@test "threshold from config: eval_iter_cap=5 in config -> eval_iter=6 triggers cap_pinned" {
    cat > "$SKILL_CONFIG_PATH" <<'EOF'
{
  "dev-flow-doctor": {
    "thresholds": {
      "eval_iter_cap": 5
    }
  }
}
EOF

    write_devflow_entry "e1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":6}' 1

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="cap_pinned" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test 9a: malformed-file tolerance -- 3 valid + 1 broken -> exit 0, total==3
# ---------------------------------------------------------------------------
@test "malformed-file tolerance: 3 valid + 1 broken -> exit 0, total_dev_flow_runs==3" {
    write_devflow_entry "valid-1.json" '{"shape":"micro","merge_tier":"AUTO","plan_iter":1,"eval_iter":0}' 1
    write_devflow_entry "valid-2.json" '{"shape":"micro","merge_tier":"AUTO","plan_iter":1,"eval_iter":0}' 2
    write_devflow_entry "valid-3.json" '{"shape":"micro","merge_tier":"AUTO","plan_iter":1,"eval_iter":0}' 3
    printf '{"broken":' > "${CLAUDE_JOURNAL_DIR}/broken.json"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 3 ]
}

# ---------------------------------------------------------------------------
# Test 9b: ARG_MAX-safe large corpus -- 8,000 long-path files -> exit 0,
#          valid JSON, total_dev_flow_runs==8000
# ---------------------------------------------------------------------------
@test "ARG_MAX regression: 8000 large-path files -> exit 0, valid JSON, total==8000" {
    local corpus
    corpus="$(mktemp -d)"
    local pad
    pad="$(printf 'a%.0s' {1..220})"
    local i
    for i in $(seq 1 8000); do
        local fname="${pad}-${i}.json"
        printf '{"id":"t-%d","timestamp":"%s","skill":"dev-flow","outcome":"success","source":"skill","telemetry":{"shape":"micro","merge_tier":"AUTO","plan_iter":1,"eval_iter":0}}\n' \
            "$i" "$TS" > "${corpus}/${fname}"
    done

    run env \
        CLAUDE_JOURNAL_DIR="$corpus" \
        SKILL_CONFIG_PATH="$SKILL_CONFIG_PATH" \
        bash "$SCRIPT" --window 30d
    rm -rf "$corpus"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 8000 ]
}

# ---------------------------------------------------------------------------
# Test 10: non-existent CLAUDE_JOURNAL_DIR -> exit 0
# ---------------------------------------------------------------------------
@test "non-existent CLAUDE_JOURNAL_DIR -> exit 0" {
    run env \
        CLAUDE_JOURNAL_DIR="/nonexistent/path/that/does/not/exist" \
        SKILL_CONFIG_PATH="$SKILL_CONFIG_PATH" \
        bash "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty
}

# ---------------------------------------------------------------------------
# Test 11: hook entries excluded from total and unknown buckets
# ---------------------------------------------------------------------------
@test "hook entries excluded from total and unknown buckets" {
    write_devflow_entry "e1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"gate_policy":"llm-major-advisory"}' 1
    write_devflow_entry "e2.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"gate_policy":"llm-major-advisory"}' 2
    write_hook_entry "hook-1.json" "h1"
    write_hook_entry "hook-2.json" "h2"
    write_hook_entry "hook-3.json" "h3"

    # legacy hook-capture source (pre-canonicalization value) -- must also be excluded
    cat > "${CLAUDE_JOURNAL_DIR}/legacy-hook.json" <<EOF
{
  "version": "1.0.0",
  "id": "legacy-hook-1",
  "timestamp": "${TS}",
  "skill": "dev-flow",
  "outcome": "failure",
  "source": "hook-capture",
  "error": { "category": "runtime", "message": "tool failed" }
}
EOF

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 2 ]

    shape_unknown=$(printf '%s\n' "$output" | jq '.distributions.shape.unknown')
    [ "$shape_unknown" -eq 0 ]

    merge_tier_unknown=$(printf '%s\n' "$output" | jq '.distributions.merge_tier.unknown')
    [ "$merge_tier_unknown" -eq 0 ]

    gate_policy_unknown=$(printf '%s\n' "$output" | jq '.distributions.gate_policy.unknown')
    [ "$gate_policy_unknown" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 12: micro_nonfiring denominator uses skill-source only
# ---------------------------------------------------------------------------
@test "micro_nonfiring denominator uses skill-source only" {
    local i
    for i in $(seq 1 9); do
        write_devflow_entry "standard-${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' "s${i}"
    done
    for i in $(seq 1 5); do
        write_hook_entry "hook-${i}.json" "h${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.total_dev_flow_runs')
    [ "$total" -eq 9 ]

    severity=$(printf '%s\n' "$output" | jq -r '[.anomalies[] | select(.type=="micro_nonfiring")][0].severity')
    [ "$severity" = "skipped" ]
}

# ---------------------------------------------------------------------------
# Test 13: iterate_status distribution unaffected by hook entries
# ---------------------------------------------------------------------------
@test "iterate_status distribution unaffected by hook entries" {
    write_devflow_entry "e1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' 1
    write_hook_entry "hook-1.json" "h1"
    write_hook_entry "hook-2.json" "h2"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    iterate_total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    [ "$iterate_total" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 14: ci_error/ci_pending counted in iterate_status distribution
# ---------------------------------------------------------------------------
@test "ci_error/ci_pending counted in iterate_status distribution" {
    for i in 1 2; do
        write_devflow_entry "ci-error-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"ci_error\"}" "ce${i}"
    done
    write_devflow_entry "ci-pending-1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"ci_pending"}' "cp1"
    write_devflow_entry "lgtm-1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "l1"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    ci_error=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.ci_error')
    ci_pending=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.ci_pending')
    unknown=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.unknown')
    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')

    [ "$ci_error" -eq 2 ]
    [ "$ci_pending" -eq 1 ]
    [ "$unknown" -eq 0 ]
    [ "$total" -eq 4 ]
}

# ---------------------------------------------------------------------------
# Test 15: ci_error counts toward iterate_unhealthy numerator
#          (lgtm x2 + ci_error x2, 2/4=50% > 30%, min_runs=3 satisfied)
# ---------------------------------------------------------------------------
@test "ci_error counts toward iterate_unhealthy numerator" {
    for i in 1 2; do
        write_devflow_entry "lgtm-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"lgtm\"}" "l${i}"
    done
    for i in 1 2; do
        write_devflow_entry "ci-error-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"ci_error\"}" "ce${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test 16: ci_pending excluded from iterate_unhealthy denominator
#          (lgtm x2 + stuck x1 + ci_pending x7: raw total=10 -> 1/10=10% would
#          not fire, but effective_total = 10 - 7 = 3 -> 1/3 ~= 33% > 30% with
#          min_runs=3 satisfied on effective_total -> fires)
# ---------------------------------------------------------------------------
@test "ci_pending excluded from iterate_unhealthy denominator" {
    for i in 1 2; do
        write_devflow_entry "lgtm-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"lgtm\"}" "l${i}"
    done
    write_devflow_entry "stuck-1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"stuck"}' "st1"
    for i in $(seq 1 7); do
        write_devflow_entry "ci-pending-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"ci_pending\"}" "cp${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]

    effective_total=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy")][0].detail.effective_total')
    ci_pending_detail=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy")][0].detail.ci_pending')

    [ "$effective_total" -eq 3 ]
    [ "$ci_pending_detail" -eq 7 ]
}

# ---------------------------------------------------------------------------
# Test 17: out-of-enum iterate_status still lands in unknown
# ---------------------------------------------------------------------------
@test "out-of-enum iterate_status still lands in unknown" {
    write_devflow_entry "bogus-1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"bogus"}' "b1"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    unknown=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.unknown')
    [ "$unknown" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 18: review_contract_error counted in iterate_status distribution,
#          not landed in unknown, and counted toward iterate_unhealthy
#          (new terminal status from issue #321; same pattern as ci_error/
#          ci_pending added in commit b1e6820).
# ---------------------------------------------------------------------------
@test "review_contract_error counted in iterate_status distribution and not unknown" {
    for i in 1 2; do
        write_devflow_entry "rce-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"review_contract_error\"}" "rce${i}"
    done
    write_devflow_entry "lgtm-1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "l1"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    review_contract_error=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.review_contract_error')
    unknown=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.unknown')
    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')

    [ "$review_contract_error" -eq 2 ]
    [ "$unknown" -eq 0 ]
    [ "$total" -eq 3 ]
}

@test "review_contract_error triggers iterate_unhealthy anomaly" {
    write_devflow_entry "lgtm-1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "l1"
    for i in 1 2 3; do
        write_devflow_entry "rce-${i}.json" "{\"shape\":\"standard\",\"merge_tier\":\"REVIEW\",\"plan_iter\":1,\"eval_iter\":1,\"iterate_status\":\"review_contract_error\"}" "rce${i}"
    done

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test 19: nested join -- dev-flow + pr-iterate entries from the same PR
#          execution (same repo/pr_number, within nested_join_window_seconds)
#          are normalized into a single run.
# ---------------------------------------------------------------------------
@test "nested join: dev-flow + pr-iterate same repo/pr within window -> 1 normalized run" {
    local ts2
    ts2=$(iso_offset "$TS" 30)
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "1" "acme/skills" "10" "$TS"
    write_priterate_entry "pi1.json" "lgtm" "1" "acme/skills" "10" "$ts2"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    raw=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.raw_entries')
    joined=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.joined_pairs')
    lgtm=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.lgtm')

    [ "$total" -eq 1 ]
    [ "$raw" -eq 2 ]
    [ "$joined" -eq 1 ]
    [ "$lgtm" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 20: standalone pr-iterate re-runs on the same PR are never joined to
#          each other (structural guarantee -- only dev-flow x pr-iterate
#          cross-skill pairs are eligible for joining).
# ---------------------------------------------------------------------------
@test "standalone pr-iterate re-runs are not joined to each other" {
    local ts2
    ts2=$(iso_offset "$TS" 60)
    write_priterate_entry "pi1.json" "lgtm" "1" "acme/skills" "20" "$TS"
    write_priterate_entry "pi2.json" "lgtm" "2" "acme/skills" "20" "$ts2"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    joined=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.joined_pairs')

    [ "$total" -eq 2 ]
    [ "$joined" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 21: a dev-flow entry joins only its nearest pr-iterate entry; an extra
#          pr-iterate re-run on the same PR remains an independent run
#          (no over-joining -- greedy matching consumes at most one pair).
# ---------------------------------------------------------------------------
@test "dev-flow joins only nearest pr-iterate, extra pr-iterate stays standalone" {
    local ts_near ts_far
    ts_near=$(iso_offset "$TS" 20)
    ts_far=$(iso_offset "$TS" 120)
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "1" "acme/skills" "30" "$TS"
    write_priterate_entry "pi-near.json" "lgtm" "near" "acme/skills" "30" "$ts_near"
    write_priterate_entry "pi-far.json" "lgtm" "far" "acme/skills" "30" "$ts_far"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    joined=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.joined_pairs')

    [ "$total" -eq 2 ]
    [ "$joined" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 22: same PR number but different repo is never joined (cross-repo
#          collision guard).
# ---------------------------------------------------------------------------
@test "cross-repo entries with the same pr_number are not joined" {
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "1" "acme/skills" "10" "$TS"
    write_priterate_entry "pi1.json" "lgtm" "1" "other/repo" "10" "$TS"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    joined=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.joined_pairs')

    [ "$total" -eq 2 ]
    [ "$joined" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 23: entries lacking correlation info (no .context) are never
#          implicitly deduped -- they are counted individually as unjoinable.
# ---------------------------------------------------------------------------
@test "legacy entries without context are unjoinable and counted individually" {
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "1"
    write_priterate_entry "pi1.json" "lgtm" "1"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    unjoinable=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.unjoinable')
    joined=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.joined_pairs')

    [ "$total" -eq 2 ]
    [ "$unjoinable" -eq 2 ]
    [ "$joined" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 24: when a joined pair's parent (dev-flow) and child (pr-iterate)
#          iterate_status disagree, the child value wins and the run is
#          counted once, with status_conflicts incremented.
# ---------------------------------------------------------------------------
@test "conflicting parent/child iterate_status counted once with status_conflicts" {
    local ts2
    ts2=$(iso_offset "$TS" 30)
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "1" "acme/skills" "40" "$TS"
    write_priterate_entry "pi1.json" "stuck" "1" "acme/skills" "40" "$ts2"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    stuck=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.stuck')
    lgtm=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.lgtm')
    conflicts=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.status_conflicts')

    [ "$total" -eq 1 ]
    [ "$stuck" -eq 1 ]
    [ "$lgtm" -eq 0 ]
    [ "$conflicts" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 25: entries beyond nested_join_window_seconds are not joined (bounded
#          fallback -- a delayed handoff flush is not incorrectly collapsed).
# ---------------------------------------------------------------------------
@test "join window boundary: entries beyond nested_join_window_seconds not joined" {
    cat > "$SKILL_CONFIG_PATH" <<'EOF'
{
  "dev-flow-doctor": {
    "thresholds": {
      "nested_join_window_seconds": 600
    }
  }
}
EOF

    local ts2
    ts2=$(iso_offset "$TS" 7200)
    write_devflow_entry "df1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "1" "acme/skills" "50" "$TS"
    write_priterate_entry "pi1.json" "lgtm" "1" "acme/skills" "50" "$ts2"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    joined=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.normalization.joined_pairs')

    [ "$total" -eq 2 ]
    [ "$joined" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 26: iterate_unhealthy anomaly must be evaluated against the
#          *normalized* population, not the raw entry count. 3 nested pairs
#          (parent+child, both lgtm) + 2 standalone pr-iterate "stuck" runs:
#          raw non-lgtm rate is 2/8=25% (would not fire), but normalized rate
#          is 2/5=40% (> 30% threshold) -- it must fire, proving the
#          denominator switch.
# ---------------------------------------------------------------------------
@test "iterate_unhealthy anomaly uses normalized denominator, not raw" {
    local i
    for i in 1 2 3; do
        local pr_num=$((100 + i))
        local ts2
        ts2=$(iso_offset "$TS" 30)
        write_devflow_entry "df${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1,"iterate_status":"lgtm"}' "p${i}" "acme/skills" "$pr_num" "$TS"
        write_priterate_entry "pi${i}.json" "lgtm" "c${i}" "acme/skills" "$pr_num" "$ts2"
    done
    write_priterate_entry "stuck1.json" "stuck" "s1"
    write_priterate_entry "stuck2.json" "stuck" "s2"

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    raw=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.raw_entries')
    total=$(printf '%s\n' "$output" | jq '.distributions.iterate_status.total')
    [ "$raw" -eq 8 ]
    [ "$total" -eq 5 ]

    found=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy" and .severity=="warn")] | length')
    [ "$found" -ge 1 ]

    detail_total=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy")][0].detail.total')
    detail_raw=$(printf '%s\n' "$output" | jq '[.anomalies[] | select(.type=="iterate_unhealthy")][0].detail.raw_entries')
    [ "$detail_total" -eq 5 ]
    [ "$detail_raw" -eq 8 ]
}
