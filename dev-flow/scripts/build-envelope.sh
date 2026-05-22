#!/usr/bin/env bash
# build-envelope.sh - Pure conversion: skill 実行結果 → decision-input envelope.
#
# child-split mode の top-level orchestration で、各 phase の決定論的ソース
# (run-batch-loop.sh JSON / dev-integrate JSON / git-pr JSON / iterate.json)
# を _lib/scripts/flow-decide.sh が消費する decision-input envelope
# (_lib/schemas/decision-input.schema.json) に変換する **副作用なしの純関数**。
#
# invoke-skill-poc.sh の raw text は parse しない。常に決定論的ソース
# (JSON / state ファイル) のみを入力とする。
#
# Usage:
#   build-envelope.sh batch_loop --batch-result JSON_OR_FILE --flow-state PATH
#   build-envelope.sh integrate  --integrate-result JSON_OR_FILE
#   build-envelope.sh final_pr   --pr-result JSON_OR_FILE --ci-status STATUS
#   build-envelope.sh pr_iterate --iterate-state JSON_OR_FILE
#
# Output (stdout, single-line JSON): decision-input envelope (phase 別 oneOf branch)
#
# Exit codes:
#   0 - envelope successfully produced
#   1 - invalid input / missing field / inconsistent data / unknown phase
#
# Conversion table (issue #112 Q2):
#   batch_loop : run-batch-loop.sh JSON + flow.json children[]
#       completed_children = issues_succeeded
#       failed_children    = issues_failed + (results[]|select(.status=="skipped")|length)
#       invariant: completed_children + failed_children == (flow.json.children|length)
#   integrate  : dev-integrate JSON {type_check, validation}
#       tests_pass      = (type_check ∈ {passed,skipped}) && (validation == passed)
#       merge_conflicts = []   (merge は batch_loop の auto-merge-child で完結済)
#   final_pr   : git-pr JSON {pr_url} + ci_status (orchestrate の gh pr checks polling 解決)
#       {pr_url, ci_status}   (純関数: ci_status は引数で受取る)
#   pr_iterate : iterate.json {status, current_iteration}
#       decision   = status   (in_progress は来ない前提、来たら abort)
#       iterations = current_iteration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

PHASE="${1:-}"
shift || true

[[ -n "$PHASE" ]] || die_json "phase argument required (batch_loop|integrate|final_pr|pr_iterate)" 1

# Resolve a --opt value that may be inline JSON or a file path.
resolve_json() {
    local val="$1"
    if [[ -f "$val" ]]; then
        cat "$val"
    else
        printf '%s' "$val"
    fi
}

BATCH_RESULT=""
INTEGRATE_RESULT=""
PR_RESULT=""
CI_STATUS=""
ITERATE_STATE=""
FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --batch-result) BATCH_RESULT="$2"; shift 2 ;;
        --integrate-result) INTEGRATE_RESULT="$2"; shift 2 ;;
        --pr-result) PR_RESULT="$2"; shift 2 ;;
        --ci-status) CI_STATUS="$2"; shift 2 ;;
        --iterate-state) ITERATE_STATE="$2"; shift 2 ;;
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,46p' "$0"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

case "$PHASE" in
    batch_loop)
        [[ -n "$BATCH_RESULT" ]] || die_json "batch_loop requires --batch-result" 1
        [[ -n "$FLOW_STATE" ]] || die_json "batch_loop requires --flow-state" 1
        [[ -f "$FLOW_STATE" ]] || die_json "flow.json not found: $FLOW_STATE" 1

        RESULT="$(resolve_json "$BATCH_RESULT")"
        if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
            die_json "--batch-result is not valid JSON" 1
        fi
        # run-batch-loop.sh emits issues_succeeded / issues_failed / results[].
        if ! echo "$RESULT" | jq -e '.issues_succeeded != null and .issues_failed != null and (.results | type == "array")' >/dev/null 2>&1; then
            die_json "batch_loop result missing required fields (issues_succeeded, issues_failed, results[])" 1
        fi

        COMPLETED=$(echo "$RESULT" | jq '.issues_succeeded')
        # skipped は top-level キーでなく results[] から集約 (Round3-c)
        SKIPPED=$(echo "$RESULT" | jq '[.results[] | select(.status == "skipped")] | length')
        FAILED_RAW=$(echo "$RESULT" | jq '.issues_failed')
        FAILED=$((FAILED_RAW + SKIPPED))

        TOTAL_CHILDREN=$(jq '.children | length' "$FLOW_STATE")
        if (( COMPLETED + FAILED != TOTAL_CHILDREN )); then
            die_json "batch_loop envelope inconsistent: completed($COMPLETED) + failed($FAILED) [= issues_failed($FAILED_RAW) + skipped($SKIPPED)] != children($TOTAL_CHILDREN)" 1
        fi

        jq -n \
            --argjson completed "$COMPLETED" \
            --argjson failed "$FAILED" \
            '{phase: "batch_loop", completed_children: $completed, failed_children: $failed}'
        ;;

    integrate)
        [[ -n "$INTEGRATE_RESULT" ]] || die_json "integrate requires --integrate-result" 1
        RESULT="$(resolve_json "$INTEGRATE_RESULT")"
        if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
            die_json "--integrate-result is not valid JSON" 1
        fi
        if ! echo "$RESULT" | jq -e '.type_check != null and .validation != null' >/dev/null 2>&1; then
            die_json "integrate result missing required fields (type_check, validation)" 1
        fi

        TYPE_CHECK=$(echo "$RESULT" | jq -r '.type_check')
        VALIDATION=$(echo "$RESULT" | jq -r '.validation')

        # tests_pass = (type_check ∈ {passed,skipped}) && (validation == passed)
        TESTS_PASS="false"
        if [[ "$TYPE_CHECK" == "passed" || "$TYPE_CHECK" == "skipped" ]] && [[ "$VALIDATION" == "passed" ]]; then
            TESTS_PASS="true"
        fi

        # merge は batch_loop の auto-merge-child で完結済 → integrate では発生しない
        jq -n \
            --argjson tests_pass "$TESTS_PASS" \
            '{phase: "integrate", merge_conflicts: [], tests_pass: $tests_pass}'
        ;;

    final_pr)
        [[ -n "$PR_RESULT" ]] || die_json "final_pr requires --pr-result" 1
        [[ -n "$CI_STATUS" ]] || die_json "final_pr requires --ci-status (resolved by orchestrate polling)" 1
        RESULT="$(resolve_json "$PR_RESULT")"
        if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
            die_json "--pr-result is not valid JSON" 1
        fi
        PR_URL=$(echo "$RESULT" | jq -r '.pr_url // empty')
        [[ -n "$PR_URL" ]] || die_json "final_pr result missing pr_url" 1

        # decision-input.schema.json enum: passed | failed | pending | unknown.
        # polling timeout は orchestrate 側で ci_status=failed に正規化して渡す
        # (timeout は schema enum 外。flow-decide は ci_status!=passed で abort するため等価)。
        case "$CI_STATUS" in
            passed|failed|pending|unknown) ;;
            *) die_json "final_pr --ci-status must be one of: passed|failed|pending|unknown (got: $CI_STATUS)" 1 ;;
        esac

        jq -n \
            --arg pr_url "$PR_URL" \
            --arg ci_status "$CI_STATUS" \
            '{phase: "final_pr", pr_url: $pr_url, ci_status: $ci_status}'
        ;;

    pr_iterate)
        [[ -n "$ITERATE_STATE" ]] || die_json "pr_iterate requires --iterate-state" 1
        RESULT="$(resolve_json "$ITERATE_STATE")"
        if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
            die_json "--iterate-state is not valid JSON" 1
        fi
        if ! echo "$RESULT" | jq -e '.status != null and .current_iteration != null' >/dev/null 2>&1; then
            die_json "pr_iterate state missing required fields (status, current_iteration)" 1
        fi

        STATUS=$(echo "$RESULT" | jq -r '.status')
        ITERATIONS=$(echo "$RESULT" | jq -r '.current_iteration')

        # decision = status. in_progress は来ない前提 (来たら abort)。
        if [[ "$STATUS" == "in_progress" ]]; then
            die_json "pr_iterate state still in_progress (current_iteration=$ITERATIONS); orchestrate must not build envelope until pr-iterate terminates." 1
        fi
        case "$STATUS" in
            lgtm|max_reached|failed) ;;
            *) die_json "pr_iterate state.status invalid: $STATUS (valid: lgtm|max_reached|failed; in_progress aborts)" 1 ;;
        esac

        jq -n \
            --arg decision "$STATUS" \
            --argjson iterations "$ITERATIONS" \
            '{phase: "pr_iterate", decision: $decision, iterations: $iterations}'
        ;;

    *)
        die_json "Unknown phase: $PHASE (valid: batch_loop|integrate|final_pr|pr_iterate; decompose は dev-decompose が内包)" 1
        ;;
esac
