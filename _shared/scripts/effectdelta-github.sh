#!/usr/bin/env bash
# effectdelta-github.sh - GitHub adapter for the EffectDelta trust-layer protocol
# (issue #412, epic #390 Phase 4). Wraps `gh` write-once/read-only effect calls
# (PR create/observe, PR summary comment) with classification delegated to the thin
# CLI (_lib/trust-effectdelta-cli.mjs, which wraps the pure core in
# _lib/trust-effectdelta.mjs). Pattern follows dev-issue-analyze/scripts/
# surfaceproof-snapshot.sh + _lib/trust-surfaceproof-cli.mjs (script does gh I/O,
# CLI does pure classification).
#
# Subcommands:
#   pr-observe <issue> --repo R --worktree WT --pr N
#     Read-only. Classifies the current state of an existing PR against the local
#     worktree's HEAD (intended.head_oid) via `gh pr view`/`gh pr list`. Never
#     writes.
#   pr-ensure <issue> --repo R --worktree WT --base B --title-file F --body-file F2
#     Write-once. Only invoked from bats fixtures in this PR (not wired into
#     dev-flow.js shadow probing) — the real `gh pr create` path continues to run
#     through the git-pr skill. Finds-or-creates: skips `gh pr create` when a
#     matching open PR (base+head_oid+state=OPEN) is already discovered.
#   comment-ensure --repo R --pr N --body-file F --effect-type T --run-id ID
#     Write-once. Derives effect_id via the CLI *before* any gh write (so the
#     kill switch / repo allowlist gate the comment write, not just its
#     classification), embeds a `commentMarker` line, searches for an existing
#     marker match before posting (duplicate suppression), and re-searches after
#     posting for readback verification.
#
# None of the three subcommands perform blind retries. Ambiguous outcomes
# (provider timeout / lost response) are resolved via read-only rediscovery only,
# and fall through to the CLI's closed observed|mismatch|inconclusive taxonomy.
#
# gh call failures that are not part of the modeled write-once/rediscovery flow
# (e.g. a listing that fails before we know whether to skip creation) are NOT
# fatal: the script emits `{"ok":false,"error":"..."}` to stdout and exits 0, so
# that an exec-proxy caller can transcribe the result verbatim instead of the
# script dying via die_json. Only script-level usage errors (missing subcommand /
# required flag) use die_json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_gh_auth
require_cmd "jq" "jq is required for JSON parsing. Install: brew install jq"
require_cmd "node" "node is required to run trust-effectdelta-cli.mjs."

CLI="$SCRIPT_DIR/../../_lib/trust-effectdelta-cli.mjs"

# The layer's configured mode intent. Whether this actually takes effect (vs.
# resolving to 'off') is decided by resolveLayerMode inside the CLI (repo
# allowlist + kill switch). This script always *intends* shadow; TRUST_LAYER_CONFIG
# in _lib/trust-wiring.mjs governs whether dev-flow.js invokes this script at all.
CONFIGURED_MODE="shadow"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/effectdelta.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

usage() {
    cat << EOF
Usage:
  effectdelta-github.sh pr-observe <issue> --repo R --worktree WT --pr N
  effectdelta-github.sh pr-ensure <issue> --repo R --worktree WT --base B --title-file F --body-file F2
  effectdelta-github.sh comment-ensure --repo R --pr N --body-file F --effect-type T --run-id ID
EOF
}

kill_switch_bool() {
    if [[ -n "${TRUST_KILL_SWITCH:-}" ]]; then
        echo "true"
    else
        echo "false"
    fi
}

resolve_repo() {
    local repo_arg="$1"
    if [[ -n "$repo_arg" ]]; then
        echo "$repo_arg"
        return
    fi
    gh repo view --json nameWithOwner -q .nameWithOwner
}

# emit_gh_error <context> <stderr-file>: prints {"ok":false,"error":"..."} to
# stdout (never to stderr — exec-proxy callers transcribe stdout verbatim) and
# returns 0 so callers can `emit_gh_error ...; exit 0` without tripping set -e.
emit_gh_error() {
    local context="$1" err_file="$2" msg
    if [[ -s "$err_file" ]]; then
        msg="$context: $(cat "$err_file")"
    else
        msg="$context"
    fi
    printf '{"ok":false,"error":%s}\n' "$(printf '%s' "$msg" | jq -Rs .)"
}

write_json() {
    # write_json <path> <json-string>
    printf '%s' "$2" > "$1"
}

call_cli_or_bail() {
    # call_cli_or_bail <op> <input-file> -> stdout: CLI JSON on success.
    # On CLI failure: prints {"ok":false,"error":...} and returns 1 (caller must
    # `if ! OUT=$(call_cli_or_bail ...); then exit 0; fi`).
    local op="$1" input_file="$2" err_file
    err_file="$TMP_DIR/cli_err_$$_$RANDOM"
    if ! node "$CLI" "$op" --input "$input_file" 2>"$err_file"; then
        emit_gh_error "trust-effectdelta-cli $op failed" "$err_file"
        return 1
    fi
    return 0
}

# ============================================================================
# pr-observe: read-only classification of an existing PR
# ============================================================================
cmd_pr_observe() {
    local issue="" repo="" worktree="" pr=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo) repo="$2"; shift 2 ;;
            --worktree) worktree="$2"; shift 2 ;;
            --pr) pr="$2"; shift 2 ;;
            -*) die_json "Unknown option: $1" ;;
            *) [[ -z "$issue" ]] && issue="$1"; shift ;;
        esac
    done
    [[ -z "$issue" ]] && die_json "pr-observe: issue number required"
    [[ -z "$worktree" ]] && die_json "pr-observe: --worktree required"
    [[ -z "$pr" ]] && die_json "pr-observe: --pr required"

    repo=$(resolve_repo "$repo")
    local head_oid
    head_oid=$(git -C "$worktree" rev-parse HEAD)

    local view_err="$TMP_DIR/pr_view_err"
    local view_json
    if ! view_json=$(gh pr view "$pr" --repo "$repo" --json baseRefName,headRefOid,number,url,state 2>"$view_err"); then
        emit_gh_error "gh pr view $pr failed" "$view_err"
        exit 0
    fi
    local base
    base=$(printf '%s' "$view_json" | jq -r '.baseRefName')

    local list_err="$TMP_DIR/pr_list_err"
    local candidates_json="null"
    local branch
    branch=$(git -C "$worktree" rev-parse --abbrev-ref HEAD)
    if list_out=$(gh pr list --repo "$repo" --head "$branch" --state open --json number,url,baseRefName,headRefOid,state 2>"$list_err"); then
        candidates_json="$list_out"
    fi

    local input_file="$TMP_DIR/pr_observe_input.json"
    write_json "$input_file" "$(jq -n \
        --arg repoSlug "$repo" \
        --argjson killSwitch "$(kill_switch_bool)" \
        --arg configuredMode "$CONFIGURED_MODE" \
        --arg repo "$repo" \
        --argjson issue "$issue" \
        --arg base "$base" \
        --arg head_oid "$head_oid" \
        --argjson candidates "$candidates_json" \
        --argjson readback "$view_json" \
        '{repoSlug:$repoSlug, killSwitch:$killSwitch, configuredMode:$configuredMode,
          intended:{repo:$repo, issue:$issue, base:$base, head_oid:$head_oid},
          candidates:$candidates, readback:$readback, responseLost:false}')"

    local out
    if ! out=$(call_cli_or_bail pr-classify "$input_file"); then
        exit 0
    fi
    printf '%s\n' "$out"
}

# ============================================================================
# pr-ensure: write-once find-or-create + rediscovery
# ============================================================================

# matched_pr_entry <candidates-json> <base> <head-oid>: prints the first entry in
# candidates matching state=OPEN + base + head_oid, or "null".
matched_pr_entry() {
    local candidates="$1" base="$2" head_oid="$3"
    printf '%s' "$candidates" | jq -c --arg base "$base" --arg head_oid "$head_oid" \
        '[.[] | select(.state == "OPEN" and .baseRefName == $base and .headRefOid == $head_oid)][0] // null'
}

cmd_pr_ensure() {
    local issue="" repo="" worktree="" base="" title_file="" body_file=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo) repo="$2"; shift 2 ;;
            --worktree) worktree="$2"; shift 2 ;;
            --base) base="$2"; shift 2 ;;
            --title-file) title_file="$2"; shift 2 ;;
            --body-file) body_file="$2"; shift 2 ;;
            -*) die_json "Unknown option: $1" ;;
            *) [[ -z "$issue" ]] && issue="$1"; shift ;;
        esac
    done
    [[ -z "$issue" ]] && die_json "pr-ensure: issue number required"
    [[ -z "$worktree" ]] && die_json "pr-ensure: --worktree required"
    [[ -z "$base" ]] && die_json "pr-ensure: --base required"
    [[ -z "$title_file" ]] && die_json "pr-ensure: --title-file required"
    [[ -z "$body_file" ]] && die_json "pr-ensure: --body-file required"

    repo=$(resolve_repo "$repo")
    local head_oid branch
    head_oid=$(git -C "$worktree" rev-parse HEAD)
    branch=$(git -C "$worktree" rev-parse --abbrev-ref HEAD)

    # Mode gate BEFORE any gh write: intended.{repo,issue,base,head_oid} are all
    # known without a gh call, so we can resolve mode up front and bail before
    # touching gh at all when off (kill switch / repo allowlist).
    local gate_input="$TMP_DIR/pr_ensure_gate.json"
    write_json "$gate_input" "$(jq -n \
        --arg repoSlug "$repo" \
        --argjson killSwitch "$(kill_switch_bool)" \
        --arg configuredMode "$CONFIGURED_MODE" \
        --arg repo "$repo" \
        --argjson issue "$issue" \
        --arg base "$base" \
        --arg head_oid "$head_oid" \
        '{repoSlug:$repoSlug, killSwitch:$killSwitch, configuredMode:$configuredMode,
          intended:{repo:$repo, issue:$issue, base:$base, head_oid:$head_oid},
          candidates:null, readback:null, responseLost:false}')"
    local gate_out
    if ! gate_out=$(call_cli_or_bail pr-classify "$gate_input"); then
        exit 0
    fi
    local gate_mode
    gate_mode=$(printf '%s' "$gate_out" | jq -r '.mode')
    if [[ "$gate_mode" == "off" ]]; then
        printf '{"ok":true,"mode":"off"}\n'
        exit 0
    fi

    # (1) Pre-creation exploration: an already-open matching PR means idempotent
    #     skip (no gh pr create call at all).
    local list_err="$TMP_DIR/pr_ensure_list_err"
    local existing_json
    if ! existing_json=$(gh pr list --repo "$repo" --head "$branch" --state open --json number,url,baseRefName,headRefOid,state 2>"$list_err"); then
        emit_gh_error "gh pr list failed (pre-creation discovery)" "$list_err"
        exit 0
    fi
    local existing_match
    existing_match=$(matched_pr_entry "$existing_json" "$base" "$head_oid")

    local candidates_json="$existing_json"
    local readback_json="null"
    local response_lost="false"

    if [[ "$existing_match" != "null" ]]; then
        readback_json="$existing_match"
    else
        local create_err="$TMP_DIR/pr_create_err"
        local create_out
        if create_out=$(gh pr create --repo "$repo" --base "$base" --head "$branch" --title-file "$title_file" --body-file "$body_file" 2>"$create_err"); then
            response_lost="false"
            local new_url new_number view_err view_json
            new_url=$(printf '%s' "$create_out" | tail -1)
            new_number=$(printf '%s' "$new_url" | grep -oE '[0-9]+$' || true)
            view_err="$TMP_DIR/pr_ensure_view_err"
            if [[ -n "$new_number" ]] && view_json=$(gh pr view "$new_number" --repo "$repo" --json baseRefName,headRefOid,number,url,state 2>"$view_err"); then
                readback_json="$view_json"
            fi
        else
            response_lost="true"
        fi

        local list2_err="$TMP_DIR/pr_ensure_list2_err"
        local candidates2_json
        if candidates2_json=$(gh pr list --repo "$repo" --head "$branch" --state open --json number,url,baseRefName,headRefOid,state 2>"$list2_err"); then
            candidates_json="$candidates2_json"
        else
            candidates_json="null"
        fi

        if [[ "$readback_json" == "null" && "$candidates_json" != "null" ]]; then
            # No dedicated `gh pr view` readback (create failed / view failed) — fall
            # back to the freshest listing so a response-lost-but-actually-succeeded
            # create can still be recognized via rediscovery.
            readback_json=$(matched_pr_entry "$candidates_json" "$base" "$head_oid")
        fi
    fi

    local input_file="$TMP_DIR/pr_ensure_input.json"
    write_json "$input_file" "$(jq -n \
        --arg repoSlug "$repo" \
        --argjson killSwitch "$(kill_switch_bool)" \
        --arg configuredMode "$CONFIGURED_MODE" \
        --arg repo "$repo" \
        --argjson issue "$issue" \
        --arg base "$base" \
        --arg head_oid "$head_oid" \
        --argjson candidates "$candidates_json" \
        --argjson readback "$readback_json" \
        --argjson responseLost "$response_lost" \
        '{repoSlug:$repoSlug, killSwitch:$killSwitch, configuredMode:$configuredMode,
          intended:{repo:$repo, issue:$issue, base:$base, head_oid:$head_oid},
          candidates:$candidates, readback:$readback, responseLost:$responseLost}')"

    local out
    if ! out=$(call_cli_or_bail pr-classify "$input_file"); then
        exit 0
    fi
    printf '%s\n' "$out"
}

# ============================================================================
# comment-ensure: marker-based write-once summary comment
# ============================================================================

# find_marker_matches <repo> <pr> <marker>: prints a JSON array of
# {id, body_digest, author, pr, html_url} entries whose body contains <marker>,
# or the literal string "null" if the comments listing itself failed (probe
# failure, distinct from a successful-but-empty search). Always returns 0
# (failure is signaled via the "null" stdout literal, not the exit code) so
# callers can use a plain `VAR=$(find_marker_matches ...)` under `set -e`.
find_marker_matches() {
    local repo="$1" pr="$2" marker="$3"
    local err_file raw
    err_file="$TMP_DIR/comments_err_$$_$RANDOM"
    if ! raw=$(gh api --paginate "repos/$repo/issues/$pr/comments" 2>"$err_file"); then
        echo "null"
        return 0
    fi
    local merged filtered count result
    merged=$(printf '%s' "$raw" | jq -s -c 'add // []')
    filtered=$(printf '%s' "$merged" | jq -c --arg m "$marker" \
        '[.[] | select((.body // "") | contains($m)) | {id, author: (.user.login // ""), html_url: (.html_url // ""), body}]')
    count=$(printf '%s' "$filtered" | jq 'length')
    result="[]"
    if [[ "$count" -gt 0 ]]; then
        local i
        for ((i = 0; i < count; i++)); do
            local body_file id author html_url digest
            body_file="$TMP_DIR/marker_body_${pr}_${i}_$$_$RANDOM"
            printf '%s' "$filtered" | jq -j --argjson i "$i" '.[$i].body' > "$body_file"
            digest="sha256:$(shasum -a 256 "$body_file" | awk '{print $1}')"
            id=$(printf '%s' "$filtered" | jq --argjson i "$i" '.[$i].id')
            author=$(printf '%s' "$filtered" | jq -r --argjson i "$i" '.[$i].author')
            html_url=$(printf '%s' "$filtered" | jq -r --argjson i "$i" '.[$i].html_url')
            result=$(printf '%s' "$result" | jq -c \
                --argjson id "$id" --arg author "$author" --arg digest "$digest" --arg html_url "$html_url" --argjson pr "$pr" \
                '. + [{id:$id, body_digest:$digest, author:$author, pr:$pr, html_url:$html_url}]')
        done
    fi
    printf '%s\n' "$result"
    return 0
}

cmd_comment_ensure() {
    local repo="" pr="" body_file="" effect_type="" run_id=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo) repo="$2"; shift 2 ;;
            --pr) pr="$2"; shift 2 ;;
            --body-file) body_file="$2"; shift 2 ;;
            --effect-type) effect_type="$2"; shift 2 ;;
            --run-id) run_id="$2"; shift 2 ;;
            -*) die_json "Unknown option: $1" ;;
            *) die_json "Unexpected argument: $1" ;;
        esac
    done
    [[ -z "$repo" ]] && repo=""
    repo=$(resolve_repo "$repo")
    [[ -z "$pr" ]] && die_json "comment-ensure: --pr required"
    [[ -z "$body_file" ]] && die_json "comment-ensure: --body-file required"
    [[ -z "$effect_type" ]] && die_json "comment-ensure: --effect-type required"
    [[ -z "$run_id" ]] && die_json "comment-ensure: --run-id required"

    local body_digest
    body_digest="sha256:$(shasum -a 256 "$body_file" | awk '{print $1}')"

    # Derive effect_id BEFORE any gh call. mode resolution happens inside this CLI
    # call too, so an off mode (kill switch / repo allowlist) short-circuits here
    # without ever touching gh — comment-ensure is a shadow-only capability and
    # must never post/read GitHub when off.
    local derive_input="$TMP_DIR/derive_input.json"
    write_json "$derive_input" "$(jq -n \
        --arg repoSlug "$repo" \
        --argjson killSwitch "$(kill_switch_bool)" \
        --arg configuredMode "$CONFIGURED_MODE" \
        --arg repo "$repo" \
        --argjson pr "$pr" \
        --arg effect_type "$effect_type" \
        --arg run_id "$run_id" \
        --arg body_digest "$body_digest" \
        '{repoSlug:$repoSlug, killSwitch:$killSwitch, configuredMode:$configuredMode,
          repo:$repo, pr:$pr, effect_type:$effect_type, run_id:$run_id, body_digest:$body_digest}')"

    local derive_out
    if ! derive_out=$(call_cli_or_bail derive-comment-id "$derive_input"); then
        exit 0
    fi
    local mode
    mode=$(printf '%s' "$derive_out" | jq -r '.mode')
    if [[ "$mode" == "off" ]]; then
        printf '{"ok":true,"mode":"off","op":"comment-ensure","posted":false}\n'
        exit 0
    fi
    local effect_id
    effect_id=$(printf '%s' "$derive_out" | jq -r '.effect_id')
    local marker="<!-- devflow-effect: ${effect_id} -->"

    local post_body_file="$TMP_DIR/post_body.md"
    { cat "$body_file"; printf '\n%s\n' "$marker"; } > "$post_body_file"
    local post_body_digest
    post_body_digest="sha256:$(shasum -a 256 "$post_body_file" | awk '{print $1}')"

    # (1) Pre-post exploration: an existing marker match means the comment already
    #     exists — skip posting (duplicate suppression, idempotent).
    local pre_matches
    pre_matches=$(find_marker_matches "$repo" "$pr" "$marker")
    local pre_count=0
    if [[ "$pre_matches" != "null" ]]; then
        pre_count=$(printf '%s' "$pre_matches" | jq 'length')
    else
        emit_gh_error "gh api comments listing failed (pre-post discovery)" "$TMP_DIR/comments_err_$$_$RANDOM"
        exit 0
    fi

    local posted="false" response_lost="false" preexisting="false"
    local matches_json readback_json url
    if [[ "$pre_count" -ge 1 ]]; then
        posted="true"
        preexisting="true"
        matches_json="$pre_matches"
        readback_json="null"
        url=$(printf '%s' "$pre_matches" | jq -r '.[0].html_url // ""')
    else
        preexisting="false"
        if gh pr comment "$pr" --repo "$repo" --body-file "$post_body_file" > "$TMP_DIR/comment_post_out" 2>"$TMP_DIR/comment_post_err"; then
            response_lost="false"
        else
            response_lost="true"
        fi

        local post_matches post_count
        post_matches=$(find_marker_matches "$repo" "$pr" "$marker")
        if [[ "$post_matches" == "null" ]]; then
            matches_json="null"
            post_count=0
        else
            matches_json="$post_matches"
            post_count=$(printf '%s' "$post_matches" | jq 'length')
        fi

        if [[ "$post_count" -eq 1 ]]; then
            readback_json=$(printf '%s' "$post_matches" | jq -c '.[0]')
            posted="true"
            url=$(printf '%s' "$readback_json" | jq -r '.html_url // ""')
        else
            readback_json="null"
            posted="false"
            url=""
        fi
    fi

    local classify_input="$TMP_DIR/classify_input.json"
    write_json "$classify_input" "$(jq -n \
        --arg repoSlug "$repo" \
        --argjson killSwitch "$(kill_switch_bool)" \
        --arg configuredMode "$CONFIGURED_MODE" \
        --arg repo "$repo" \
        --argjson pr "$pr" \
        --arg effect_type "$effect_type" \
        --arg run_id "$run_id" \
        --arg body_digest "$body_digest" \
        --arg expected_body_digest "$post_body_digest" \
        --argjson matches "$matches_json" \
        --argjson readback "$readback_json" \
        --argjson responseLost "$response_lost" \
        --argjson preexisting "$preexisting" \
        '{repoSlug:$repoSlug, killSwitch:$killSwitch, configuredMode:$configuredMode,
          repo:$repo, pr:$pr, effect_type:$effect_type, run_id:$run_id, body_digest:$body_digest,
          expected_body_digest:$expected_body_digest, matches:$matches, readback:$readback,
          responseLost:$responseLost, preexisting:$preexisting}')"

    local classify_out
    if ! classify_out=$(call_cli_or_bail comment-classify "$classify_input"); then
        exit 0
    fi

    printf '%s' "$classify_out" | jq -c --argjson posted "$posted" --arg url "$url" \
        '{ok, mode, op: "comment-ensure", posted: $posted, url: $url, observation, effect_id, receipt, envelope}'
}

# ============================================================================
# dispatch
# ============================================================================
SUBCOMMAND="${1:-}"
[[ -z "$SUBCOMMAND" ]] && { usage; die_json "subcommand required"; }
shift

case "$SUBCOMMAND" in
    pr-observe) cmd_pr_observe "$@" ;;
    pr-ensure) cmd_pr_ensure "$@" ;;
    comment-ensure) cmd_comment_ensure "$@" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die_json "Unknown subcommand: $SUBCOMMAND" ;;
esac
