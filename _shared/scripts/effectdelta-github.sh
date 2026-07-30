#!/usr/bin/env bash
# effectdelta-github.sh - GitHub adapter for the EffectDelta trust-layer protocol
# (issue #412, epic #390 Phase 4; refactored to a pure file-input transform in
# issue #466). Classification is delegated to the thin CLI
# (_lib/trust-effectdelta-cli.mjs, which wraps the pure core in
# _lib/trust-effectdelta.mjs). Pattern follows dev-issue-analyze/scripts/
# surfaceproof-snapshot.sh + _lib/trust-surfaceproof-cli.mjs (script does pure
# classification, caller supplies read-only listing/readback snapshots as
# files).
#
# This script performs no authenticated network I/O of its own. Any
# `gh`-based PR/comment discovery, posting, or the branch's push happens as a
# bare single-line command in the calling subagent's turn, with stdout/stderr
# captured to a file that is passed in via a flag (see
# .claude/rules/dev-flow.md, exec-proxy invariant). This script only reads
# those files and performs deterministic classification.
#
# Subcommands:
#   pr-observe <issue> --repo R --worktree WT --pr N --base B
#     (--pr-view-json F | --pr-view-err F) [--pr-list-json F]
#     Read-only. Classifies the current state of an existing PR against the local
#     worktree's HEAD (intended.head_oid) and the caller's intended base branch
#     (--base, e.g. dev-flow.js's resolveBase result), using the caller-supplied
#     PR view/list snapshot files. `--base` must come from the caller's intent,
#     never from the readback itself — deriving it from the readback would make
#     the base comparison tautological and make base-induced WRONG_TARGET
#     structurally undetectable. Never triggers a write.
#   comment-prepare --repo R --pr N --body-file F --effect-type T --run-id ID --out-body OUT
#     Derives effect_id via the CLI *before* the caller decides whether to post
#     (so the kill switch / repo allowlist gate the write, not just its
#     classification), embeds a `commentMarker` line, and writes the resulting
#     body to --out-body for the caller to post.
#   comment-observe --repo R --pr N --body-file F --effect-type T --run-id ID
#     (--pre-comments-json F | --pre-comments-err F) [--post-comments-json F] [--response-lost]
#     Read-only. Re-derives effect_id/marker from the same inputs as
#     comment-prepare, then classifies duplicate suppression (pre-listing
#     marker match) and posted-comment readback (post-listing marker match)
#     against the caller-supplied comment listing snapshot files.
#
# None of the subcommands perform blind retries. Ambiguous outcomes
# (provider timeout / lost response) are resolved via read-only rediscovery only,
# and fall into the CLI's closed observed|mismatch|inconclusive taxonomy.
#
# Listing/readback failures that are not part of the modeled write-once/
# rediscovery flow (e.g. a listing that fails before we know whether to skip
# posting) are NOT fatal: the script emits `{"ok":false,"error":"..."}` to
# stdout and exits 0, so that an exec-proxy caller can transcribe the result
# verbatim instead of the script dying via die_json. Only script-level usage
# errors (missing subcommand / required flag) use die_json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

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
  effectdelta-github.sh pr-observe <issue> --repo R --worktree WT --pr N --base B
      (--pr-view-json F | --pr-view-err F) [--pr-list-json F]
  effectdelta-github.sh comment-prepare --repo R --pr N --body-file F --effect-type T --run-id ID --out-body OUT
  effectdelta-github.sh comment-observe --repo R --pr N --body-file F --effect-type T --run-id ID
      (--pre-comments-json F | --pre-comments-err F) [--post-comments-json F] [--response-lost]
EOF
}

kill_switch_bool() {
    if [[ -n "${TRUST_KILL_SWITCH:-}" ]]; then
        echo "true"
    else
        echo "false"
    fi
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
    local issue="" repo="" worktree="" pr="" base="" view_json_file="" view_err_file="" list_json_file=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo) repo="$2"; shift 2 ;;
            --worktree) worktree="$2"; shift 2 ;;
            --pr) pr="$2"; shift 2 ;;
            --base) base="$2"; shift 2 ;;
            --pr-view-json) view_json_file="$2"; shift 2 ;;
            --pr-view-err) view_err_file="$2"; shift 2 ;;
            --pr-list-json) list_json_file="$2"; shift 2 ;;
            -*) die_json "Unknown option: $1" ;;
            *) [[ -z "$issue" ]] && issue="$1"; shift ;;
        esac
    done
    [[ -z "$issue" ]] && die_json "pr-observe: issue number required"
    [[ -z "$repo" ]] && die_json "pr-observe: --repo required"
    [[ -z "$worktree" ]] && die_json "pr-observe: --worktree required"
    [[ -z "$pr" ]] && die_json "pr-observe: --pr required"
    [[ -z "$base" ]] && die_json "pr-observe: --base required"
    if [[ -z "$view_json_file" && -z "$view_err_file" ]]; then
        die_json "pr-observe: one of --pr-view-json or --pr-view-err is required"
    fi
    if [[ -n "$view_json_file" && -n "$view_err_file" ]]; then
        die_json "pr-observe: --pr-view-json and --pr-view-err are mutually exclusive"
    fi

    # Local read-only worktree state. Kept in-script (not moved to the
    # subagent) — see .claude/rules/dev-flow.md exec-proxy invariant and the
    # issue #466 plan's architecture_decisions for pr-observe.
    local head_oid branch
    head_oid=$(git -C "$worktree" rev-parse HEAD)
    branch=$(git -C "$worktree" rev-parse --abbrev-ref HEAD)

    if [[ -n "$view_err_file" ]]; then
        emit_gh_error "pr view readback failed" "$view_err_file"
        exit 0
    fi

    local view_json
    view_json=$(cat "$view_json_file") || die_json "pr-observe: failed to read --pr-view-json $view_json_file"

    local candidates_json="null"
    if [[ -n "$list_json_file" ]]; then
        candidates_json=$(cat "$list_json_file") || die_json "pr-observe: failed to read --pr-list-json $list_json_file"
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
# comment-prepare: derive effect_id + marker-embedded body, no reads/writes
# ============================================================================
cmd_comment_prepare() {
    local repo="" pr="" body_file="" effect_type="" run_id="" out_body=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo) repo="$2"; shift 2 ;;
            --pr) pr="$2"; shift 2 ;;
            --body-file) body_file="$2"; shift 2 ;;
            --effect-type) effect_type="$2"; shift 2 ;;
            --run-id) run_id="$2"; shift 2 ;;
            --out-body) out_body="$2"; shift 2 ;;
            -*) die_json "Unknown option: $1" ;;
            *) die_json "Unexpected argument: $1" ;;
        esac
    done
    [[ -z "$repo" ]] && die_json "comment-prepare: --repo required"
    [[ -z "$pr" ]] && die_json "comment-prepare: --pr required"
    [[ -z "$body_file" ]] && die_json "comment-prepare: --body-file required"
    [[ -z "$effect_type" ]] && die_json "comment-prepare: --effect-type required"
    [[ -z "$run_id" ]] && die_json "comment-prepare: --run-id required"
    [[ -z "$out_body" ]] && die_json "comment-prepare: --out-body required"

    local body_digest
    body_digest="sha256:$(shasum -a 256 "$body_file" | awk '{print $1}')"

    # Derive effect_id BEFORE the caller decides whether to post. mode
    # resolution happens inside this CLI call too, so an off mode (kill switch
    # / repo allowlist) short-circuits here without ever authorizing a write —
    # comment-prepare is a shadow-only capability and must never authorize a
    # post when off.
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

    { cat "$body_file"; printf '\n%s\n' "$marker"; } > "$out_body"

    jq -n --arg mode "$mode" --arg effect_id "$effect_id" --arg marker "$marker" \
        '{ok:true, mode:$mode, effect_id:$effect_id, marker:$marker}'
}

# ============================================================================
# comment-observe: marker-based classification from caller-supplied snapshots
# ============================================================================

# find_marker_matches_file <comments-json-file> <marker> <pr>: prints a JSON
# array of {id, body_digest, author, pr, html_url} entries whose body contains
# <marker>. <comments-json-file> holds the verbatim stdout of the caller's
# paginated comment-listing call (one JSON array per page, newline-
# concatenated), merged the same way a live paginated call would be.
find_marker_matches_file() {
    local file="$1" marker="$2" pr="$3"
    local merged filtered count result
    merged=$(jq -s -c 'add // []' "$file")
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
}

cmd_comment_observe() {
    local repo="" pr="" body_file="" effect_type="" run_id="" pre_json="" pre_err="" post_json="" response_lost="false"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo) repo="$2"; shift 2 ;;
            --pr) pr="$2"; shift 2 ;;
            --body-file) body_file="$2"; shift 2 ;;
            --effect-type) effect_type="$2"; shift 2 ;;
            --run-id) run_id="$2"; shift 2 ;;
            --pre-comments-json) pre_json="$2"; shift 2 ;;
            --pre-comments-err) pre_err="$2"; shift 2 ;;
            --post-comments-json) post_json="$2"; shift 2 ;;
            --response-lost) response_lost="true"; shift 1 ;;
            -*) die_json "Unknown option: $1" ;;
            *) die_json "Unexpected argument: $1" ;;
        esac
    done
    [[ -z "$repo" ]] && die_json "comment-observe: --repo required"
    [[ -z "$pr" ]] && die_json "comment-observe: --pr required"
    [[ -z "$body_file" ]] && die_json "comment-observe: --body-file required"
    [[ -z "$effect_type" ]] && die_json "comment-observe: --effect-type required"
    [[ -z "$run_id" ]] && die_json "comment-observe: --run-id required"
    if [[ -z "$pre_json" && -z "$pre_err" ]]; then
        die_json "comment-observe: one of --pre-comments-json or --pre-comments-err is required"
    fi
    if [[ -n "$pre_json" && -n "$pre_err" ]]; then
        die_json "comment-observe: --pre-comments-json and --pre-comments-err are mutually exclusive"
    fi

    local body_digest
    body_digest="sha256:$(shasum -a 256 "$body_file" | awk '{print $1}')"

    # Re-derive effect_id/mode from the same inputs comment-prepare used.
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

    if [[ -n "$pre_err" ]]; then
        emit_gh_error "comments listing failed (pre-post discovery)" "$pre_err"
        exit 0
    fi

    # (1) Pre-post exploration: an existing marker match means the comment already
    #     exists — treat as posted (duplicate suppression, idempotent).
    local pre_matches pre_count
    pre_matches=$(find_marker_matches_file "$pre_json" "$marker" "$pr")
    pre_count=$(printf '%s' "$pre_matches" | jq 'length')

    local posted="false" preexisting="false"
    local matches_json="null" readback_json="null" url=""
    if [[ "$pre_count" -ge 1 ]]; then
        posted="true"
        preexisting="true"
        matches_json="$pre_matches"
        readback_json="null"
        url=$(printf '%s' "$pre_matches" | jq -r '.[0].html_url // ""')
    else
        preexisting="false"
        if [[ -n "$post_json" ]]; then
            local post_matches post_count
            post_matches=$(find_marker_matches_file "$post_json" "$marker" "$pr")
            post_count=$(printf '%s' "$post_matches" | jq 'length')
            matches_json="$post_matches"
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
    comment-prepare) cmd_comment_prepare "$@" ;;
    comment-observe) cmd_comment_observe "$@" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die_json "Unknown subcommand: $SUBCOMMAND" ;;
esac
