#!/usr/bin/env bash
# flow-decide.sh - Decide next action for child-split mode top-level orchestration.
# READ-ONLY: never mutates flow.json. Callers are responsible for updating
# state via flow-update.sh phase <name> <status> [...].
#
# Usage:
#   flow-decide.sh --flow-state PATH --phase NAME --result JSON_OR_FILE [--allow-partial]
#
# Output (stdout, single-line JSON):
#   {"next_action": "skill"|"complete"|"abort"|"retry",
#    "skill": "<skill-name>?",
#    "args": ["..."]?,
#    "phase": "<next-phase>?",
#    "reason": "<human readable>"}
#
# Exit codes:
#   0 - decision successfully produced (next_action could still be "abort")
#   1 - invalid input / schema error / unknown phase / unreadable flow.json
#
# Transition table (v2.1 child-split mode top-level):
#   decompose  + children > 0           -> skill run-batch-loop  (phase batch_loop)
#   decompose  + children == 0          -> abort (no children)
#   batch_loop + failed==0              -> skill dev-integrate   (phase integrate)
#   batch_loop + failed>0 default       -> abort
#   batch_loop + failed>0 --allow-partial -> skill dev-integrate (warning)
#   integrate  + tests_pass + no_conflict -> skill git-pr        (phase final_pr)
#   integrate  + tests_pass==false      -> abort
#   integrate  + merge_conflicts > 0    -> abort
#   final_pr   + ci_status==passed      -> skill pr-iterate      (phase pr_iterate)
#   final_pr   + ci_status!=passed      -> abort
#   pr_iterate + decision==lgtm         -> complete
#   pr_iterate + decision==max_reached  -> complete (status: partial)
#   pr_iterate + decision==failed       -> abort
#   any        + phases[].attempts >= 3 + status==failed -> abort (max retry)
#   any        + status==failed + retry_target!=null     -> retry retry_target

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""
PHASE=""
RESULT_INPUT=""
ALLOW_PARTIAL="false"
MAX_RETRY="${FLOW_DECIDE_MAX_RETRY:-3}"

usage() {
    cat <<EOF
Usage: $(basename "$0") --flow-state PATH --phase NAME --result JSON_OR_FILE [--allow-partial]

Decides next action for child-split mode top-level orchestration.

Options:
  --flow-state PATH    Path to flow.json (v2.1)
  --phase NAME         Current phase: decompose | batch_loop | integrate | final_pr | pr_iterate
  --result VAL         JSON string (inline) or path to JSON file with phase result
  --allow-partial      For batch_loop: continue to integrate even with failed_children > 0
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --phase) PHASE="$2"; shift 2 ;;
        --result) RESULT_INPUT="$2"; shift 2 ;;
        --allow-partial) ALLOW_PARTIAL="true"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "--flow-state required" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found: $FLOW_STATE" 1
[[ -n "$PHASE" ]] || die_json "--phase required" 1
[[ -n "$RESULT_INPUT" ]] || die_json "--result required" 1

# Reject v2.0 / v1 / unknown versions (no-backcompat).
VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
if [[ "$VERSION" != "2.1.0" ]]; then
    die_json "flow.json schema version must be 2.1.0 (got: \"$VERSION\"). v2.0 / v1 は schema error (no-backcompat)." 1
fi

VALID_PHASES="decompose batch_loop integrate final_pr pr_iterate"
if ! echo "$VALID_PHASES" | grep -qw "$PHASE"; then
    die_json "Invalid phase: $PHASE. Valid: $VALID_PHASES" 1
fi

# Resolve result to JSON string
if [[ -f "$RESULT_INPUT" ]]; then
    RESULT=$(cat "$RESULT_INPUT")
else
    RESULT="$RESULT_INPUT"
fi

# Validate result is JSON
if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
    die_json "--result is not valid JSON" 1
fi

# Validate result phase matches --phase
RESULT_PHASE=$(echo "$RESULT" | jq -r '.phase // empty')
if [[ "$RESULT_PHASE" != "$PHASE" ]]; then
    die_json "result.phase '$RESULT_PHASE' does not match --phase '$PHASE'" 1
fi

# Validate phases[] uniqueness (defensive; schema also enforces)
DUP=$(jq -r '[.phases[].name] | group_by(.) | map(select(length>1) | .[0]) | .[]' "$FLOW_STATE" 2>/dev/null || true)
if [[ -n "$DUP" ]]; then
    die_json "Duplicate phase name(s) in flow.json.phases[]: $DUP" 1
fi

# Helper: emit decision JSON to stdout. Args:
#   $1 = next_action (skill|complete|abort|retry)
#   $2 = skill (or empty)
#   $3 = next phase (or empty)
#   $4 = reason
#   $5+ = args (each one arg)
emit_decision() {
    local action="$1"; shift
    local skill="$1"; shift
    local next_phase="$1"; shift
    local reason="$1"; shift
    local args_json="[]"
    if [[ $# -gt 0 ]]; then
        args_json=$(printf '%s\n' "$@" | jq -R . | jq -s .)
    fi
    jq -n \
        --arg na "$action" \
        --arg sk "$skill" \
        --arg ph "$next_phase" \
        --arg rs "$reason" \
        --argjson args "$args_json" \
        '{
            next_action: $na,
            skill: (if $sk == "" then null else $sk end),
            phase: (if $ph == "" then null else $ph end),
            args: $args,
            reason: $rs
        }'
}

# --- Max-retry / retry_target shortcut (any phase) ---
ATTEMPTS=$(jq -r --arg n "$PHASE" '.phases[] | select(.name == $n) | .attempts // 0' "$FLOW_STATE")
CUR_STATUS=$(jq -r --arg n "$PHASE" '.phases[] | select(.name == $n) | .status // "pending"' "$FLOW_STATE")
RETRY_TARGET=$(jq -r --arg n "$PHASE" '.phases[] | select(.name == $n) | .retry_target // empty' "$FLOW_STATE")

if [[ -z "$ATTEMPTS" ]]; then
    die_json "Phase '$PHASE' not present in flow.json.phases[] (seed missing?)" 1
fi

# If the current phase is failed (already recorded by flow-update.sh) and a
# retry_target is set, jump to that phase. Caller must subsequently increment
# attempts via `flow-update.sh phase <retry_target> running --attempts +1`.
if [[ "$CUR_STATUS" == "failed" && -n "$RETRY_TARGET" && "$RETRY_TARGET" != "abort" ]]; then
    if (( ATTEMPTS >= MAX_RETRY )); then
        emit_decision "abort" "" "" "max retry exceeded (attempts=$ATTEMPTS, max=$MAX_RETRY); caller must NOT retry."
        exit 0
    fi
    emit_decision "retry" "" "$RETRY_TARGET" "Retry from failed phase '$PHASE' to '$RETRY_TARGET'. Caller must increment attempts via flow-update.sh phase $RETRY_TARGET running --attempts +1."
    exit 0
fi

if [[ "$CUR_STATUS" == "failed" && "$RETRY_TARGET" == "abort" ]]; then
    emit_decision "abort" "" "" "Phase '$PHASE' failed with retry_target=abort."
    exit 0
fi

if (( ATTEMPTS >= MAX_RETRY )); then
    emit_decision "abort" "" "" "max retry exceeded for phase '$PHASE' (attempts=$ATTEMPTS, max=$MAX_RETRY)."
    exit 0
fi

# --- Per-phase transition logic ---
case "$PHASE" in
    decompose)
        # decision-input: {children_created: [...], batches: [...]}
        if ! echo "$RESULT" | jq -e '.children_created and .batches' >/dev/null 2>&1; then
            die_json "decompose result missing required fields (children_created, batches)" 1
        fi
        CHILD_CNT=$(echo "$RESULT" | jq '.children_created | length')
        if (( CHILD_CNT == 0 )); then
            emit_decision "abort" "" "" "decompose produced 0 children — nothing to orchestrate."
            exit 0
        fi
        emit_decision "skill" "run-batch-loop" "batch_loop" \
            "decompose done (children=$CHILD_CNT). Caller must transition phase batch_loop to running before dispatch." \
            "--flow-state" "$FLOW_STATE"
        ;;

    batch_loop)
        if ! echo "$RESULT" | jq -e '.completed_children != null and .failed_children != null' >/dev/null 2>&1; then
            die_json "batch_loop result missing required fields (completed_children, failed_children)" 1
        fi
        COMPLETED=$(echo "$RESULT" | jq '.completed_children')
        FAILED=$(echo "$RESULT" | jq '.failed_children')
        TOTAL_CHILDREN=$(jq '.children | length' "$FLOW_STATE")
        if (( COMPLETED + FAILED != TOTAL_CHILDREN )); then
            die_json "batch_loop result inconsistent: completed($COMPLETED) + failed($FAILED) != total_children($TOTAL_CHILDREN)" 1
        fi
        if (( FAILED == 0 )); then
            emit_decision "skill" "dev-integrate" "integrate" \
                "batch_loop done (completed=$COMPLETED, failed=0). Transition to integrate." \
                "--flow-state" "$FLOW_STATE"
        else
            if [[ "$ALLOW_PARTIAL" == "true" ]]; then
                emit_decision "skill" "dev-integrate" "integrate" \
                    "batch_loop partial (completed=$COMPLETED, failed=$FAILED). Continuing under --allow-partial (warning)." \
                    "--flow-state" "$FLOW_STATE"
            else
                emit_decision "abort" "" "" \
                    "batch_loop failed: $FAILED child(ren) failed. Use --allow-partial to continue, or fix children first."
            fi
        fi
        ;;

    integrate)
        if ! echo "$RESULT" | jq -e '.merge_conflicts != null and .tests_pass != null' >/dev/null 2>&1; then
            die_json "integrate result missing required fields (merge_conflicts, tests_pass)" 1
        fi
        CONFLICTS=$(echo "$RESULT" | jq '.merge_conflicts | length')
        TESTS_PASS=$(echo "$RESULT" | jq -r '.tests_pass')
        if (( CONFLICTS > 0 )); then
            emit_decision "abort" "" "" "integrate failed: $CONFLICTS merge conflict(s) require manual resolution."
            exit 0
        fi
        if [[ "$TESTS_PASS" != "true" ]]; then
            emit_decision "abort" "" "" "integrate failed: integration tests did not pass."
            exit 0
        fi
        emit_decision "skill" "git-pr" "final_pr" \
            "integrate done (tests_pass, no_conflict). Transition to final_pr." \
            "--flow-state" "$FLOW_STATE"
        ;;

    final_pr)
        if ! echo "$RESULT" | jq -e '.pr_url and .ci_status' >/dev/null 2>&1; then
            die_json "final_pr result missing required fields (pr_url, ci_status)" 1
        fi
        CI_STATUS=$(echo "$RESULT" | jq -r '.ci_status')
        PR_URL=$(echo "$RESULT" | jq -r '.pr_url')
        if [[ "$CI_STATUS" != "passed" ]]; then
            emit_decision "abort" "" "" "final_pr failed: CI status=$CI_STATUS (need 'passed')."
            exit 0
        fi
        emit_decision "skill" "pr-iterate" "pr_iterate" \
            "final_pr done (CI passed at $PR_URL). Transition to pr_iterate." \
            "$PR_URL"
        ;;

    pr_iterate)
        if ! echo "$RESULT" | jq -e '.decision' >/dev/null 2>&1; then
            die_json "pr_iterate result missing required field 'decision'" 1
        fi
        DECISION=$(echo "$RESULT" | jq -r '.decision')
        ITERATIONS=$(echo "$RESULT" | jq -r '.iterations // 0')
        case "$DECISION" in
            lgtm)
                emit_decision "complete" "" "" "pr_iterate reached LGTM after $ITERATIONS iteration(s)."
                ;;
            max_reached)
                emit_decision "complete" "" "" "pr_iterate completed (partial): max_reached after $ITERATIONS iteration(s)."
                ;;
            failed)
                emit_decision "abort" "" "" "pr_iterate gave up after $ITERATIONS iteration(s)."
                ;;
            *)
                die_json "Invalid pr_iterate.decision: $DECISION (valid: lgtm|max_reached|failed)" 1
                ;;
        esac
        ;;

    *)
        die_json "Unknown phase: $PHASE" 1
        ;;
esac
