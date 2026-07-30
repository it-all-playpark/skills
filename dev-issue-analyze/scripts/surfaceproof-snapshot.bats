#!/usr/bin/env bats
# Tests for dev-issue-analyze/scripts/surfaceproof-snapshot.sh (issue #410, #390 Phase 2;
# converted to a pure transform over pre-fetched files in issue #466)
#
# Strategy: the script no longer calls `gh` itself, so tests pass the issue/comments
# payloads directly as fixture files via --issue-json / --comments-json (success) or
# --comments-err (an HTTP status embedded in stderr-style text, standing in for what a
# caller's failed `gh` invocation would have written). `curl` is still stubbed
# (same pattern as dev-issue-analyze/scripts/analyze-issue.bats) per-scenario via
# $CURL_MODE (unset/"fail" -> non-zero exit, "redirect" -> a 302 response to a
# non-allowlisted host) and always records that it was invoked via $CURL_CALLED_FILE,
# which lets the non-allowlisted-URL scenario assert curl is *never* invoked for URLs
# the allowlist rejects.
#
# The script is invoked via `bash "$SCRIPT" ...` (not direct exec) so these tests do
# not depend on the working-tree executable bit.
#
# Covers: (1) happy path freeze, (2) comments 403 -> fetch_errors + inconclusive
# verdict, (3) non-allowlisted URL -> curl never called, (4) redirect to a
# non-allowlisted host -> REDIRECT_DENIED, (5) HTTP 404 -> FETCH_FAILED, (6)
# freeze -> reconcile -> STALE_SOURCE.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-issue-analyze/scripts/surfaceproof-snapshot.sh"

    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
[[ -n "${CURL_CALLED_FILE:-}" ]] && : >> "$CURL_CALLED_FILE"

outfile=""
prev=""
for arg in "$@"; do
    if [[ "$prev" == "-o" ]]; then
        outfile="$arg"
    fi
    prev="$arg"
done

case "${CURL_MODE:-fail}" in
    redirect)
        [[ -n "$outfile" ]] && : > "$outfile"
        printf '302\t\t0\thttps://evil.example.com/redirected'
        exit 0
        ;;
    notfound)
        [[ -n "$outfile" ]] && printf 'not found' > "$outfile"
        printf '404\ttext/plain\t9\t'
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
EOF
    chmod +x "$STUB_DIR/curl"

    export PATH="$STUB_DIR:$PATH"

    FIXTURE_DIR="$BATS_TMPDIR/fixtures"
    mkdir -p "$FIXTURE_DIR"

    unset CURL_MODE CURL_CALLED_FILE
}

# make_issue_fixture <path> <title> <body> <updated_at> [labels_json]
make_issue_fixture() {
    local path="$1" title="$2" body="$3" updated_at="$4" labels="${5:-[]}"
    jq -n --arg title "$title" --arg body "$body" --arg updated_at "$updated_at" --argjson labels "$labels" \
        '{title: $title, body: $body, updated_at: $updated_at, labels: $labels}' > "$path"
}

# make_comments_fixture <path> <comments_json>
make_comments_fixture() {
    local path="$1" comments="$2"
    printf '%s' "$comments" > "$path"
}

# make_comments_err_fixture <path> <http_status>
# Stands in for the stderr text a caller's failed `gh` invocation would have
# produced and been redirected to a file (issue #466).
make_comments_err_fixture() {
    local path="$1" http_status="$2"
    printf 'Resource not accessible by integration (HTTP %s)\n' "$http_status" > "$path"
}

# ---------------------------------------------------------------------------
# (1) happy path: freeze succeeds, receipt is surfaceproof/1 with an input_pack_digest
# ---------------------------------------------------------------------------
@test "freeze: happy path -> receipt.schema_version=surfaceproof/1 with input_pack_digest" {
    ISSUE_FIXTURE="$FIXTURE_DIR/issue1.json"
    COMMENTS_FIXTURE="$FIXTURE_DIR/comments1.json"
    make_issue_fixture "$ISSUE_FIXTURE" "SurfaceProof adapter" "本文です。" "2026-07-22T00:00:00Z" '[{"name":"trust-layer"}]'
    make_comments_fixture "$COMMENTS_FIXTURE" '[{"id":1,"body":"コメントです"}]'

    run bash "$SCRIPT" 410 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE" --comments-json "$COMMENTS_FIXTURE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.receipt.schema_version == "surfaceproof/1"'
    echo "$output" | jq -e '.receipt.anchors.input_pack_digest | length > 0'
    echo "$output" | jq -e '.receipt.outcome.verdict == "pass"'
}

# ---------------------------------------------------------------------------
# (2) comments 403 -> forbidden unit + inconclusive verdict (not a false pass)
# ---------------------------------------------------------------------------
@test "freeze: comments 403 -> forbidden unit + receipt verdict inconclusive" {
    ISSUE_FIXTURE="$FIXTURE_DIR/issue2.json"
    COMMENTS_ERR_FIXTURE="$FIXTURE_DIR/comments2.err"
    make_issue_fixture "$ISSUE_FIXTURE" "SurfaceProof adapter" "本文です。" "2026-07-22T00:00:00Z"
    make_comments_err_fixture "$COMMENTS_ERR_FIXTURE" 403

    run bash "$SCRIPT" 411 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE" --comments-err "$COMMENTS_ERR_FIXTURE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.units[] | select(.kind == "comment")][0].fetch == "forbidden"'
    echo "$output" | jq -e '.receipt.outcome.verdict == "inconclusive"'
}

# ---------------------------------------------------------------------------
# (3) non-allowlisted URL in body -> curl is never invoked (no unlimited crawl)
# ---------------------------------------------------------------------------
@test "freeze: non-allowlisted URL -> curl never invoked, unit marked unsupported" {
    ISSUE_FIXTURE="$FIXTURE_DIR/issue3.json"
    COMMENTS_FIXTURE="$FIXTURE_DIR/comments3.json"
    make_issue_fixture "$ISSUE_FIXTURE" "Spec link" "spec here: https://example.com/spec.md" "2026-07-22T00:00:00Z"
    make_comments_fixture "$COMMENTS_FIXTURE" '[]'
    export CURL_MODE=fail
    export CURL_CALLED_FILE="$BATS_TMPDIR/curl-called-3"
    rm -f "$CURL_CALLED_FILE"

    run bash "$SCRIPT" 412 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE" --comments-json "$COMMENTS_FIXTURE"
    [ "$status" -eq 0 ]
    [ ! -e "$CURL_CALLED_FILE" ]
    echo "$output" | jq -e '[.units[] | select(.kind == "spec_link")][0].fetch == "unsupported"'
    echo "$output" | jq -e '[.units[] | select(.kind == "spec_link")][0].reason_code == "URL_NOT_ALLOWLISTED"'
}

# ---------------------------------------------------------------------------
# (4) redirect to a non-allowlisted host -> REDIRECT_DENIED
# ---------------------------------------------------------------------------
@test "freeze: redirect to non-allowlisted host -> REDIRECT_DENIED" {
    ISSUE_FIXTURE="$FIXTURE_DIR/issue4.json"
    COMMENTS_FIXTURE="$FIXTURE_DIR/comments4.json"
    make_issue_fixture "$ISSUE_FIXTURE" "Attached spec" "see https://github.com/it-all-playpark/skills/blob/main/spec.md" "2026-07-22T00:00:00Z"
    make_comments_fixture "$COMMENTS_FIXTURE" '[]'
    export CURL_MODE=redirect
    export CURL_CALLED_FILE="$BATS_TMPDIR/curl-called-4"
    rm -f "$CURL_CALLED_FILE"

    run bash "$SCRIPT" 413 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE" --comments-json "$COMMENTS_FIXTURE"
    [ "$status" -eq 0 ]
    [ -e "$CURL_CALLED_FILE" ]
    echo "$output" | jq -e '[.units[] | select(.reason_code == "REDIRECT_DENIED")] | length == 1'
}

# ---------------------------------------------------------------------------
# (5) HTTP 404 response -> FETCH_FAILED, not a false "fetched" (issue #416 review)
# ---------------------------------------------------------------------------
@test "freeze: HTTP 404 response -> FETCH_FAILED even when content-type matches allowlist" {
    ISSUE_FIXTURE="$FIXTURE_DIR/issue6.json"
    COMMENTS_FIXTURE="$FIXTURE_DIR/comments6.json"
    make_issue_fixture "$ISSUE_FIXTURE" "Removed spec" "see https://github.com/it-all-playpark/skills/blob/main/removed.md" "2026-07-22T00:00:00Z"
    make_comments_fixture "$COMMENTS_FIXTURE" '[]'
    export CURL_MODE=notfound
    export CURL_CALLED_FILE="$BATS_TMPDIR/curl-called-6"
    rm -f "$CURL_CALLED_FILE"

    run bash "$SCRIPT" 415 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE" --comments-json "$COMMENTS_FIXTURE"
    [ "$status" -eq 0 ]
    [ -e "$CURL_CALLED_FILE" ]
    echo "$output" | jq -e '[.units[] | select(.kind == "spec_link")][0].fetch == "failed"'
    echo "$output" | jq -e '[.units[] | select(.kind == "spec_link")][0].reason_code == "FETCH_FAILED"'
    echo "$output" | jq -e '.receipt.outcome.verdict != "pass"'
}

# ---------------------------------------------------------------------------
# (6) freeze -> reconcile: source updated after freeze -> STALE_SOURCE
# ---------------------------------------------------------------------------
@test "reconcile: source updated after freeze -> STALE_SOURCE" {
    ISSUE_FIXTURE="$FIXTURE_DIR/issue5.json"
    COMMENTS_FIXTURE="$FIXTURE_DIR/comments5.json"
    make_issue_fixture "$ISSUE_FIXTURE" "Reconcile test" "初版の本文です。" "2026-07-22T00:00:00Z"
    make_comments_fixture "$COMMENTS_FIXTURE" '[]'

    FROZEN_FILE="$BATS_TMPDIR/frozen5.json"
    run bash "$SCRIPT" 414 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE" --comments-json "$COMMENTS_FIXTURE" --freeze-out "$FROZEN_FILE"
    [ "$status" -eq 0 ]
    [ -s "$FROZEN_FILE" ]
    jq -e '.schema == "surfaceproof-freeze/1"' "$FROZEN_FILE"

    ISSUE_FIXTURE_UPDATED="$FIXTURE_DIR/issue5-updated.json"
    make_issue_fixture "$ISSUE_FIXTURE_UPDATED" "Reconcile test" "編集後の本文です。" "2026-07-22T01:00:00Z"

    run bash "$SCRIPT" 414 --repo it-all-playpark/skills --issue-json "$ISSUE_FIXTURE_UPDATED" --comments-json "$COMMENTS_FIXTURE" --reconcile-against "$FROZEN_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.reconcile.status == "STALE_SOURCE"'
}
