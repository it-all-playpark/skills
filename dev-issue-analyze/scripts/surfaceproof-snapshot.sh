#!/usr/bin/env bash
# surfaceproof-snapshot.sh - Fetch a GitHub Issue's body/comments/labels via `gh api`,
# plan+fetch referenced external URLs under a fail-closed allowlist (manual redirect
# loop, no -L), then freeze/reconcile the SurfaceProof snapshot via the thin CLI
# (_lib/trust-surfaceproof-cli.mjs, which wraps the pure core in
# _lib/trust-surfaceproof.mjs). issue #410 (#390 Phase 2, standalone shadow adapter —
# no dev-flow/Analyze wiring in this script).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_gh_auth
require_cmd "jq" "jq is required for JSON parsing. Install: brew install jq"
require_cmd "curl" "curl is required to fetch allowlisted external URLs."
require_cmd "node" "node is required to run trust-surfaceproof-cli.mjs."

CLI="$SCRIPT_DIR/../../_lib/trust-surfaceproof-cli.mjs"

ISSUE_NUMBER=""
REPO=""
FREEZE_OUT=""
RECONCILE_AGAINST=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --repo) REPO="$2"; shift 2 ;;
        --freeze-out) FREEZE_OUT="$2"; shift 2 ;;
        --reconcile-against) RECONCILE_AGAINST="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: surfaceproof-snapshot.sh <issue-number> [--repo owner/name] [--freeze-out <path>] [--reconcile-against <frozen.json>]"
            exit 0
            ;;
        -*)
            die_json "Unknown option: $1"
            ;;
        *)
            [[ -z "$ISSUE_NUMBER" ]] && ISSUE_NUMBER="$1"
            shift
            ;;
    esac
done

[[ -z "$ISSUE_NUMBER" ]] && die_json "Issue number required"

if [[ -z "$REPO" ]]; then
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) || die_json "Failed to detect repo. Pass --repo owner/name."
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/surfaceproof.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

# ============================================================================
# (1) issue 本体の取得（body/title/labels/updated_at）。ここが失敗する場合は
#     inventory の起点自体が無いため通常どおり die する。
# ============================================================================
ISSUE_RAW=$(gh api "repos/$REPO/issues/$ISSUE_NUMBER" 2>"$TMP_DIR/issue_err") || \
    die_json "Failed to fetch issue #$ISSUE_NUMBER: $(cat "$TMP_DIR/issue_err")"

ISSUE_JSON=$(printf '%s' "$ISSUE_RAW" | jq -c '{title, body, updated_at, labels: [(.labels // [])[] | {name: .name}]}')

# ============================================================================
# (2) comments の取得。403/404 等の権限不足は die せず fetch_errors に記録する
#     （fail-closed への反映は buildInventory/reconcileSource 側 pure core の責務）。
# ============================================================================
if COMMENTS_RAW=$(gh api --paginate "repos/$REPO/issues/$ISSUE_NUMBER/comments" 2>"$TMP_DIR/comments_err"); then
    COMMENTS_JSON=$(printf '%s' "$COMMENTS_RAW" | jq -s -c 'add // []')
    FETCH_ERRORS_JSON="[]"
else
    HTTP_CODE=$(grep -oE '\b(4|5)[0-9]{2}\b' "$TMP_DIR/comments_err" | head -1)
    [[ -z "$HTTP_CODE" ]] && HTTP_CODE=500
    COMMENTS_JSON="[]"
    FETCH_ERRORS_JSON=$(jq -n --argjson code "$HTTP_CODE" '[{resource: "comments", http_status: $code}]')
fi

# ============================================================================
# (3) snapshot 組み立て
# ============================================================================
SNAPSHOT=$(jq -n \
    --arg repo "$REPO" \
    --argjson issue_number "$ISSUE_NUMBER" \
    --argjson issue "$ISSUE_JSON" \
    --argjson comments "$COMMENTS_JSON" \
    --argjson fetch_errors "$FETCH_ERRORS_JSON" \
    '{schema: "surfaceproof-snapshot/1", repo: $repo, issue_number: $issue_number, issue: $issue, comments: $comments, fetch_errors: $fetch_errors}')

SNAPSHOT_FILE="$TMP_DIR/snapshot.json"
printf '%s' "$SNAPSHOT" > "$SNAPSHOT_FILE"

# ============================================================================
# (4) plan-fetch: 外部 URL 一覧 + allowlist 判定を CLI（pure core evaluateUrlPolicy 経由）から取得
# ============================================================================
PLAN=$(node "$CLI" plan-fetch < "$SNAPSHOT_FILE") || die_json "plan-fetch failed"

# ============================================================================
# (5) allowlist を通過した URL のみ curl で fetch する（無制限クロール禁止）。
#     redirect は -L を使わず手動 loop で 1 hop ずつ host を再判定する。
# ============================================================================
MAX_HOPS=3
MAX_BYTES=1048576
ALLOWED_CONTENT_TYPES="text/plain text/markdown text/x-markdown application/json"

is_allowed_content_type() {
    local ct="$1" allowed
    for allowed in $ALLOWED_CONTENT_TYPES; do
        [[ "$ct" == "$allowed" ]] && return 0
    done
    return 1
}

denied_result() {
    # $1=start_url $2=reason_code
    jq -nc --arg url "$1" --arg reason_code "$2" \
        '{url: $url, status: "failed", reason_code: $reason_code, final_url: null, content_type: null, size_bytes: null, content_digest: null}'
}

# 再判定は pure core の evaluateUrlPolicy を単一ソースのまま再利用するため、CLI の
# plan-fetch を pseudo snapshot（body=candidate url のみ）で呼び直す。allowlist の
# 二重管理を避ける（設計判断: SURFACEPROOF_URL_POLICY.allowlist を唯一の真実源にする）。
check_host_allowed() {
    local url="$1" pseudo plan
    pseudo=$(jq -n --arg body "$url" '{issue: {body: $body}, comments: []}')
    if ! plan=$(printf '%s' "$pseudo" | node "$CLI" plan-fetch 2>/dev/null); then
        echo "false"
        return
    fi
    printf '%s' "$plan" | jq -r --arg u "$url" '([.urls[] | select(.url == $u) | .allowed][0]) // false'
}

fetch_one() {
    # $1 = start url. stdout に fetch 結果 JSON を 1 件出す。
    local start_url="$1" current_url="$1" hop=0
    while true; do
        local out_file meta curl_exit=0 http_code content_type size_bytes redirect_url
        out_file="$TMP_DIR/body_$(printf '%s' "$current_url" | shasum -a 256 | cut -c1-16)_${hop}"
        meta=$(curl -s -o "$out_file" --max-filesize "$MAX_BYTES" \
            -w '%{http_code}\t%{content_type}\t%{size_download}\t%{redirect_url}' \
            "$current_url") || curl_exit=$?

        if [[ $curl_exit -ne 0 ]]; then
            if [[ $curl_exit -eq 63 ]]; then
                denied_result "$start_url" "SIZE_EXCEEDED"
            else
                denied_result "$start_url" "FETCH_FAILED"
            fi
            return
        fi

        # NOTE: not `IFS=$'\t' read` — bash's IFS-whitespace field-splitting collapses
        # consecutive tab delimiters (empty middle fields silently disappear), which
        # would misalign fields whenever content_type/redirect_url is empty. awk -F'\t'
        # treats tab as a literal (non-collapsing) separator, so empty fields are kept.
        http_code=$(awk -F'\t' '{print $1}' <<<"$meta")
        content_type=$(awk -F'\t' '{print $2}' <<<"$meta")
        size_bytes=$(awk -F'\t' '{print $3}' <<<"$meta")
        redirect_url=$(awk -F'\t' '{print $4}' <<<"$meta")

        if [[ "$http_code" =~ ^3[0-9][0-9]$ && -n "$redirect_url" ]]; then
            hop=$((hop + 1))
            if (( hop > MAX_HOPS )); then
                denied_result "$start_url" "REDIRECT_DENIED"
                return
            fi
            local allowed
            allowed=$(check_host_allowed "$redirect_url")
            if [[ "$allowed" != "true" ]]; then
                denied_result "$start_url" "REDIRECT_DENIED"
                return
            fi
            current_url="$redirect_url"
            continue
        fi

        if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
            # 2xx 以外（404/410/5xx 等）は content-type が偶然 allowlist と一致しても
            # "fetched" とみなさない。curl は 404 応答でも exit 0 を返すため、この
            # チェックが無いと消えたリンクのエラーページが FETCH_FAILED ではなく
            # fetched/OK として receipt に載ってしまう（issue #416 review 指摘）。
            denied_result "$start_url" "FETCH_FAILED"
            return
        fi

        if [[ "$size_bytes" =~ ^[0-9]+$ ]] && (( size_bytes > MAX_BYTES )); then
            denied_result "$start_url" "SIZE_EXCEEDED"
            return
        fi

        local normalized_ct
        normalized_ct=$(printf '%s' "$content_type" | cut -d';' -f1 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
        if ! is_allowed_content_type "$normalized_ct"; then
            denied_result "$start_url" "CONTENT_TYPE_DENIED"
            return
        fi

        local digest
        digest="sha256:$(shasum -a 256 "$out_file" | awk '{print $1}')"
        jq -nc --arg url "$start_url" --arg final_url "$current_url" --arg content_type "$normalized_ct" \
            --argjson size_bytes "${size_bytes:-0}" --arg digest "$digest" \
            '{url: $url, status: "fetched", reason_code: "OK", final_url: $final_url, content_type: $content_type, size_bytes: $size_bytes, content_digest: $digest}'
        return
    done
}

FETCHES_JSON="[]"
ALLOWED_URLS=$(printf '%s' "$PLAN" | jq -r '.urls[] | select(.allowed == true) | .url')
if [[ -n "$ALLOWED_URLS" ]]; then
    while IFS= read -r url; do
        [[ -z "$url" ]] && continue
        RESULT=$(fetch_one "$url")
        FETCHES_JSON=$(printf '%s' "$FETCHES_JSON" | jq -c --argjson r "$RESULT" '. + [$r]')
    done <<<"$ALLOWED_URLS"
fi

FETCHES_FILE="$TMP_DIR/fetches.json"
printf '%s' "$FETCHES_JSON" > "$FETCHES_FILE"

# ============================================================================
# (6) freeze もしくは reconcile を CLI 経由で実行し stdout へ結果 JSON を出す
# ============================================================================
if [[ -n "$RECONCILE_AGAINST" ]]; then
    OUTPUT=$(node "$CLI" reconcile --frozen "$RECONCILE_AGAINST" < "$SNAPSHOT_FILE") || die_json "reconcile failed"
else
    OUTPUT=$(node "$CLI" freeze --fetches "$FETCHES_FILE" < "$SNAPSHOT_FILE") || die_json "freeze failed"
    if [[ -n "$FREEZE_OUT" ]]; then
        printf '%s' "$OUTPUT" | jq '.frozen' > "$FREEZE_OUT"
    fi
fi

printf '%s\n' "$OUTPUT"
