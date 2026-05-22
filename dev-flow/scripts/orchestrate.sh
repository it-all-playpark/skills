#!/usr/bin/env bash
# orchestrate.sh - child-split mode top-level decision loop (Stage 3).
#
# flow-decide.sh (decision engine) を駆動する bash decision loop。各 phase で
#   1. skill を実行 (invoke-skill-poc.sh sync / 委譲先 helper)
#   2. 決定論的ソースを build-envelope.sh で decision-input envelope に純変換
#   3. flow-decide.sh に渡して next_action を得る
#   4. flow-update.sh で flow.json phase 状態を更新
#   5. next_action に従って遷移 (skill 続行 / retry / complete / abort)
# を繰り返す。
#
# **起点は batch_loop**。decompose phase は dev-decompose が内包し、Step 8 validate
# 直後に `flow-update phase decompose done` を呼ぶ前提 (issue #112 Q3)。
# orchestrate は decompose==done の flow.json を受け取り、batch_loop から開始する。
#
# Usage:
#   orchestrate.sh --flow-state PATH --worktree PATH [--allow-partial]
#                  [--base BRANCH] [--lang ja|en] [--max-iterations N]
#                  [--poll-max N] [--poll-interval SEC] [--dry-run]
#
# Exit codes:
#   0 - flow completed (next_action == complete)
#   1 - invalid input / setup error
#   2 - flow aborted (next_action == abort) — manual intervention required
#   3 - skill invocation error (invoke-skill-poc exit 2/3/4 propagated)
#
# Design refs (issue #112):
#   Q4  : invoke-skill-poc.sh sync; exit code 0=success / 2=agent_error / 3=timeout
#         / 4=unsupported → 2/3/4 は abort
#   Q5  : flow-decide が retry を返したら `flow-update phase <t> running --attempts +1`
#         を必ず呼んでから同 skill 再実行 (attempts++ 忘れ → 無限ループ防止)
#   Q6  : build-envelope.sh = 純変換。`gh pr checks` polling は orchestrate (本 script) 側
#   Q11 : --allow-partial default off。明示時のみ flow-decide に伝播
#   Q12 : gh pr checks polling は最大 poll-max(30) × poll-interval(20s) = 10 分上限。
#         timeout → ci_status=failed (schema enum 外の "timeout" は failed に正規化、
#         flow-decide は ci_status!=passed で abort するため等価)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SKILLS_REPO/_lib/common.sh"

require_cmds jq

BUILD_ENVELOPE="$SCRIPT_DIR/build-envelope.sh"
FLOW_DECIDE="$SKILLS_REPO/_lib/scripts/flow-decide.sh"
FLOW_UPDATE="$SKILLS_REPO/_lib/scripts/flow-update.sh"
RUN_BATCH_LOOP="$SKILLS_REPO/_shared/scripts/run-batch-loop.sh"
AUTO_MERGE_CHILD="$SCRIPT_DIR/auto-merge-child.sh"

FLOW_STATE=""
WORKTREE=""
ALLOW_PARTIAL="false"
BASE=""
LANG_OPT="ja"
MAX_ITER="20"
POLL_MAX="${ORCHESTRATE_POLL_MAX:-30}"
POLL_INTERVAL="${ORCHESTRATE_POLL_INTERVAL:-20}"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        --allow-partial) ALLOW_PARTIAL="true"; shift ;;
        --base) BASE="$2"; shift 2 ;;
        --lang) LANG_OPT="$2"; shift 2 ;;
        --max-iterations) MAX_ITER="$2"; shift 2 ;;
        --poll-max) POLL_MAX="$2"; shift 2 ;;
        --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
        --dry-run) DRY_RUN="true"; shift ;;
        -h|--help)
            sed -n '2,40p' "$0"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "--flow-state required" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found: $FLOW_STATE" 1
[[ -n "$WORKTREE" ]] || die_json "--worktree required" 1

# Reject non-2.1.0 (no-backcompat). Mirror flow-decide / flow-update gate.
VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
[[ "$VERSION" == "2.1.0" ]] || die_json "flow.json schema version must be 2.1.0 (got: \"$VERSION\")" 1

# decompose must be done before orchestrate runs (Q3: dev-decompose 内包).
DECOMPOSE_STATUS=$(jq -r '.phases[] | select(.name=="decompose") | .status' "$FLOW_STATE")
[[ "$DECOMPOSE_STATUS" == "done" ]] || die_json "orchestrate requires decompose phase == done (got: \"$DECOMPOSE_STATUS\"). dev-decompose must finalize decompose before orchestrate." 1

INTEGRATION_BRANCH=$(jq -r '.integration_branch.name' "$FLOW_STATE")
[[ -z "$BASE" ]] && BASE=$(jq -r '.config.base_branch // .integration_branch.base' "$FLOW_STATE")

log() { echo "[orchestrate] $*" >&2; }

ALLOW_PARTIAL_ARG=()
[[ "$ALLOW_PARTIAL" == "true" ]] && ALLOW_PARTIAL_ARG=(--allow-partial)

# ---------------------------------------------------------------------------
# gh pr checks polling helper (Q6 / Q12). Resolves CI status for a PR.
# Echoes one of: passed | failed | pending | unknown (schema enum).
# timeout → failed (flow-decide aborts on != passed; "timeout" is enum-external).
# ---------------------------------------------------------------------------
poll_ci_status() {
    local pr_url="$1"
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "${ORCHESTRATE_DRY_CI_STATUS:-passed}"
        return 0
    fi
    require_cmd gh
    local attempt=0
    local raw rc
    while (( attempt < POLL_MAX )); do
        attempt=$((attempt + 1))
        # `gh pr checks` exit: 0 all pass, 8 pending, !=0 some failed/none.
        raw=$(gh pr checks "$pr_url" 2>/dev/null) && rc=0 || rc=$?
        if (( rc == 0 )); then
            echo "passed"; return 0
        elif (( rc == 8 )); then
            log "CI pending for $pr_url (attempt $attempt/$POLL_MAX); sleeping ${POLL_INTERVAL}s"
            sleep "$POLL_INTERVAL"
            continue
        else
            # Non-pending non-zero: failures present, or no checks configured.
            if [[ -z "$raw" ]]; then
                echo "unknown"; return 0
            fi
            echo "failed"; return 0
        fi
    done
    log "CI polling timed out after $((POLL_MAX * POLL_INTERVAL))s for $pr_url → treating as failed"
    echo "failed"
}

# ---------------------------------------------------------------------------
# Phase runners. Each runs the deterministic source for the phase, returns the
# raw result on stdout (caller converts via build-envelope.sh).
# ---------------------------------------------------------------------------

run_batch_loop_phase() {
    local batches_json state_file
    batches_json=$(mktemp)
    jq '.batches' "$FLOW_STATE" > "$batches_json"
    state_file="$WORKTREE/.claude/batch-state.json"
    if [[ "$DRY_RUN" == "true" ]]; then
        # Dry-run: emit injected batch result if provided (test hook), else
        # synthesize a fully-successful batch result from children[].
        if [[ -n "${ORCHESTRATE_DRY_BATCH_RESULT:-}" ]]; then
            cat "$ORCHESTRATE_DRY_BATCH_RESULT"
        else
            jq -n --argjson succ "$(jq '.children | length' "$FLOW_STATE")" \
                '{status:"ok",batches_processed:1,batches_skipped:0,issues_succeeded:$succ,issues_failed:0,fail_fast_triggered:false,results:[]}'
        fi
        rm -f "$batches_json"
        return 0
    fi
    "$RUN_BATCH_LOOP" \
        --batches-json "$batches_json" \
        --issue-runner "Skill: dev-flow {issue} --force-single --base $INTEGRATION_BRANCH --lang $LANG_OPT" \
        --on-success "$AUTO_MERGE_CHILD {issue} --base $INTEGRATION_BRANCH --flow-state $FLOW_STATE" \
        --state-file "$state_file" \
        --fail-fast
    rm -f "$batches_json"
}

run_integrate_phase() {
    if [[ "$DRY_RUN" == "true" ]]; then
        jq -n '{status:"integrated",type_check:"skipped",validation:"passed"}'
        return 0
    fi
    # dev-integrate skill produces {status, type_check, validation}.
    invoke_skill "Skill: dev-integrate --flow-state $FLOW_STATE --base $INTEGRATION_BRANCH"
}

run_final_pr_phase() {
    if [[ "$DRY_RUN" == "true" ]]; then
        jq -n '{pr_url:"https://github.com/dry/run/pull/1",title:"dry-run",branch:"b",base:"d"}'
        return 0
    fi
    # git-pr skill produces {pr_url, title, branch, base, worktree}.
    invoke_skill "Skill: git-pr $(jq -r '.issue' "$FLOW_STATE") --base $BASE --lang $LANG_OPT --worktree $WORKTREE"
}

run_pr_iterate_phase() {
    local pr_url="$1"
    if [[ "$DRY_RUN" == "true" ]]; then
        jq -n '{version:"1.0",status:"lgtm",current_iteration:1}'
        return 0
    fi
    # pr-iterate skill persists iterate.json; we read it back as the source.
    invoke_skill "Skill: pr-iterate $pr_url" >/dev/null
    local iterate_json="$WORKTREE/.claude/iterate.json"
    [[ -f "$iterate_json" ]] || die_json "pr-iterate did not produce iterate.json at $iterate_json" 3
    cat "$iterate_json"
}

# invoke_skill: run a skill prompt synchronously via invoke-skill-poc.sh and
# propagate its exit codes (Q4: 2=agent_error/3=timeout/4=unsupported → abort).
invoke_skill() {
    local prompt="$1"
    local out rc
    out=$(bash "$SKILLS_REPO/_lib/scripts/invoke-skill-poc.sh" "$prompt") && rc=0 || rc=$?
    if (( rc != 0 )); then
        log "skill invocation failed (exit $rc): $prompt"
        exit 3
    fi
    printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Decision loop
# ---------------------------------------------------------------------------

# Helper: read current phase status from flow.json.
phase_status() { jq -r --arg n "$1" '.phases[] | select(.name==$n) | .status' "$FLOW_STATE"; }

# Determine starting phase: first of [batch_loop..pr_iterate] not yet done.
resolve_start_phase() {
    local p
    for p in batch_loop integrate final_pr pr_iterate; do
        if [[ "$(phase_status "$p")" != "done" ]]; then
            echo "$p"; return 0
        fi
    done
    echo ""  # all done
}

PHASE="$(resolve_start_phase)"
if [[ -z "$PHASE" ]]; then
    log "all phases already done; nothing to orchestrate."
    echo '{"status":"completed","reason":"all phases done"}'
    exit 0
fi

# Carry the PR url discovered in final_pr through to pr_iterate.
FINAL_PR_URL=""

iter=0
while (( iter < MAX_ITER )); do
    iter=$((iter + 1))
    log "iteration $iter: phase=$PHASE"

    # Resume-from-failed guard (Q5): if this phase still carries a `failed`
    # status from a prior orchestrate run, consult flow-decide BEFORE we
    # overwrite the status to `running`. flow-decide's retry/abort shortcut is
    # gated on `status == "failed"`, so marking running first would silently
    # swallow the retry decision (and re-run / done-ify a failed phase).
    if [[ "$(phase_status "$PHASE")" == "failed" ]]; then
        # flow-decide validates result.phase == --phase; the retry/abort
        # shortcut is gated on flow.json status, so a minimal phase-only
        # envelope is sufficient here (the phase is not re-run yet).
        RESUME_FILE=$(mktemp)
        jq -n --arg p "$PHASE" '{phase:$p}' > "$RESUME_FILE"
        RESUME_DECISION=$("$FLOW_DECIDE" --flow-state "$FLOW_STATE" --phase "$PHASE" --result "$RESUME_FILE" "${ALLOW_PARTIAL_ARG[@]}")
        rm -f "$RESUME_FILE"
        RESUME_ACTION=$(echo "$RESUME_DECISION" | jq -r '.next_action')
        RESUME_PHASE=$(echo "$RESUME_DECISION" | jq -r '.phase // empty')
        RESUME_REASON=$(echo "$RESUME_DECISION" | jq -r '.reason')
        log "resume-from-failed decision: $RESUME_ACTION ${RESUME_PHASE:+→ $RESUME_PHASE} ($RESUME_REASON)"
        case "$RESUME_ACTION" in
            retry)
                # Q5: bump attempts on the retry target before re-running.
                "$FLOW_UPDATE" --flow-state "$FLOW_STATE" phase "$RESUME_PHASE" running --attempts +1 >/dev/null
                PHASE="$RESUME_PHASE"
                ;;
            abort)
                "$FLOW_UPDATE" --flow-state "$FLOW_STATE" status failed >/dev/null
                log "flow aborted on resume: $RESUME_REASON"
                jq -n --arg reason "$RESUME_REASON" --arg phase "$PHASE" \
                    '{status:"aborted",phase:$phase,reason:$reason}'
                exit 2
                ;;
            *)
                die_json "Unexpected resume decision '$RESUME_ACTION' for failed phase '$PHASE'" 1
                ;;
        esac
    fi

    # Mark phase running.
    "$FLOW_UPDATE" --flow-state "$FLOW_STATE" phase "$PHASE" running >/dev/null

    # Run the phase + build envelope.
    ENVELOPE=""
    case "$PHASE" in
        batch_loop)
            RESULT=$(run_batch_loop_phase)
            ENVELOPE=$("$BUILD_ENVELOPE" batch_loop --flow-state "$FLOW_STATE" --batch-result "$RESULT")
            ;;
        integrate)
            RESULT=$(run_integrate_phase)
            ENVELOPE=$("$BUILD_ENVELOPE" integrate --integrate-result "$RESULT")
            ;;
        final_pr)
            RESULT=$(run_final_pr_phase)
            FINAL_PR_URL=$(echo "$RESULT" | jq -r '.pr_url')
            CI=$(poll_ci_status "$FINAL_PR_URL")
            ENVELOPE=$("$BUILD_ENVELOPE" final_pr --pr-result "$RESULT" --ci-status "$CI")
            ;;
        pr_iterate)
            RESULT=$(run_pr_iterate_phase "$FINAL_PR_URL")
            ENVELOPE=$("$BUILD_ENVELOPE" pr_iterate --iterate-state "$RESULT")
            ;;
        *)
            die_json "Unexpected phase in loop: $PHASE" 1
            ;;
    esac

    # Decide next action.
    ENV_FILE=$(mktemp)
    echo "$ENVELOPE" | jq -c . > "$ENV_FILE"
    DECISION=$("$FLOW_DECIDE" --flow-state "$FLOW_STATE" --phase "$PHASE" --result "$ENV_FILE" "${ALLOW_PARTIAL_ARG[@]}")
    rm -f "$ENV_FILE"

    NEXT_ACTION=$(echo "$DECISION" | jq -r '.next_action')
    NEXT_PHASE=$(echo "$DECISION" | jq -r '.phase // empty')
    REASON=$(echo "$DECISION" | jq -r '.reason')
    log "decision: $NEXT_ACTION ${NEXT_PHASE:+→ $NEXT_PHASE} ($REASON)"

    case "$NEXT_ACTION" in
        skill)
            # Current phase succeeded; mark done and advance.
            "$FLOW_UPDATE" --flow-state "$FLOW_STATE" phase "$PHASE" done >/dev/null
            PHASE="$NEXT_PHASE"
            ;;
        complete)
            "$FLOW_UPDATE" --flow-state "$FLOW_STATE" phase "$PHASE" done >/dev/null
            "$FLOW_UPDATE" --flow-state "$FLOW_STATE" status integrated >/dev/null
            log "flow complete: $REASON"
            jq -n --arg reason "$REASON" --arg pr "$FINAL_PR_URL" \
                '{status:"completed",reason:$reason,final_pr_url:(if $pr=="" then null else $pr end)}'
            exit 0
            ;;
        retry)
            # Q5: increment attempts on the retry target BEFORE re-running.
            "$FLOW_UPDATE" --flow-state "$FLOW_STATE" phase "$NEXT_PHASE" running --attempts +1 >/dev/null
            PHASE="$NEXT_PHASE"
            ;;
        abort)
            "$FLOW_UPDATE" --flow-state "$FLOW_STATE" phase "$PHASE" failed --retry-target abort >/dev/null
            "$FLOW_UPDATE" --flow-state "$FLOW_STATE" status failed >/dev/null
            log "flow aborted: $REASON"
            jq -n --arg reason "$REASON" --arg phase "$PHASE" \
                '{status:"aborted",phase:$phase,reason:$reason}'
            exit 2
            ;;
        *)
            die_json "Unknown next_action from flow-decide: $NEXT_ACTION" 1
            ;;
    esac
done

die_json "orchestrate exceeded max iterations ($MAX_ITER) without completing" 2
