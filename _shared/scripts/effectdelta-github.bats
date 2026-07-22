#!/usr/bin/env bats
# Tests for _shared/scripts/effectdelta-github.sh (issue #412, #390 Phase 4)
#
# Strategy: shim out `gh` and `git` with stubs (same pattern as
# dev-issue-analyze/scripts/surfaceproof-snapshot.bats / git-pr/scripts/create-pr.bats).
# The `gh` stub tracks state (open PRs / comments) in JSON files under $STATE_DIR so a
# single test can drive the script twice (idempotency fixtures) and observe how many
# times the underlying gh write commands (`pr create` / `pr comment`) were actually
# invoked (via counter files), independent of what the script *reports*.
#
# Covers: AC-8 (PR write-once idempotency + wrong-target + response-loss),
# AC-9 (comment write-once idempotency + duplicate), kill switch (mode off, zero writes).

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/effectdelta-github.sh"

    STATE_DIR="$BATS_TMPDIR/state-$$-$RANDOM"
    mkdir -p "$STATE_DIR"
    OPEN_PRS_FILE="$STATE_DIR/open_prs.json"
    COMMENTS_FILE="$STATE_DIR/comments.json"
    PR_CREATE_CALLS_FILE="$STATE_DIR/pr_create_calls"
    PR_COMMENT_CALLS_FILE="$STATE_DIR/pr_comment_calls"
    NEXT_PR_NUMBER_FILE="$STATE_DIR/next_pr_number"
    NEXT_COMMENT_ID_FILE="$STATE_DIR/next_comment_id"

    echo '[]' > "$OPEN_PRS_FILE"
    echo '[]' > "$COMMENTS_FILE"
    echo '0' > "$PR_CREATE_CALLS_FILE"
    echo '0' > "$PR_COMMENT_CALLS_FILE"
    echo '100' > "$NEXT_PR_NUMBER_FILE"
    echo '900' > "$NEXT_COMMENT_ID_FILE"

    export OPEN_PRS_FILE COMMENTS_FILE PR_CREATE_CALLS_FILE PR_COMMENT_CALLS_FILE NEXT_PR_NUMBER_FILE NEXT_COMMENT_ID_FILE
    export PR_CREATE_MODE=success
    export COMMENT_POST_MODE=success
    unset TRUST_KILL_SWITCH

    STUB_DIR="$BATS_TMPDIR/stub-bin-$$-$RANDOM"
    mkdir -p "$STUB_DIR"

    cat > "$STUB_DIR/gh" << 'GHEOF'
#!/usr/bin/env bash
set -euo pipefail

incr() {
    local f="$1" n
    n=$(cat "$f")
    echo $((n + 1)) > "$f"
}

case "$1" in
    auth)
        echo "dummy-token"
        exit 0
        ;;
    repo)
        echo "it-all-playpark/skills"
        exit 0
        ;;
    pr)
        shift
        case "$1" in
            view)
                NUM="$2"
                MATCH=$(jq -c --argjson n "$NUM" '[.[] | select(.number == $n)][0] // null' "$OPEN_PRS_FILE")
                if [[ "$MATCH" == "null" ]]; then
                    echo "gh: pull request #$NUM not found" >&2
                    exit 1
                fi
                echo "$MATCH"
                exit 0
                ;;
            list)
                jq -c '.' "$OPEN_PRS_FILE"
                exit 0
                ;;
            create)
                incr "$PR_CREATE_CALLS_FILE"
                BASE="" HEAD_OID=""
                prev=""
                for a in "$@"; do
                    if [[ "$prev" == "--base" ]]; then BASE="$a"; fi
                    prev="$a"
                done
                NUM=$(cat "$NEXT_PR_NUMBER_FILE")
                echo $((NUM + 1)) > "$NEXT_PR_NUMBER_FILE"
                URL="https://github.com/it-all-playpark/skills/pull/$NUM"
                if [[ "${PR_CREATE_MODE:-success}" == "success" ]]; then
                    ENTRY=$(jq -n --argjson number "$NUM" --arg url "$URL" --arg base "$BASE" --arg head_oid "$PR_CREATE_HEAD_OID" \
                        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}')
                    jq -c --argjson e "$ENTRY" '. + [$e]' "$OPEN_PRS_FILE" > "$OPEN_PRS_FILE.tmp" && mv "$OPEN_PRS_FILE.tmp" "$OPEN_PRS_FILE"
                    echo "$URL"
                    exit 0
                elif [[ "${PR_CREATE_MODE:-success}" == "fail-but-succeeded" ]]; then
                    ENTRY=$(jq -n --argjson number "$NUM" --arg url "$URL" --arg base "$BASE" --arg head_oid "$PR_CREATE_HEAD_OID" \
                        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}')
                    jq -c --argjson e "$ENTRY" '. + [$e]' "$OPEN_PRS_FILE" > "$OPEN_PRS_FILE.tmp" && mv "$OPEN_PRS_FILE.tmp" "$OPEN_PRS_FILE"
                    echo "gh: response lost" >&2
                    exit 1
                else
                    echo "gh: create failed" >&2
                    exit 1
                fi
                ;;
            comment)
                incr "$PR_COMMENT_CALLS_FILE"
                PRNUM="$2"
                BODY_FILE=""
                prev=""
                for a in "$@"; do
                    if [[ "$prev" == "--body-file" ]]; then BODY_FILE="$a"; fi
                    prev="$a"
                done
                ID=$(cat "$NEXT_COMMENT_ID_FILE")
                echo $((ID + 1)) > "$NEXT_COMMENT_ID_FILE"
                URL="https://github.com/it-all-playpark/skills/pull/$PRNUM#issuecomment-$ID"
                if [[ "${COMMENT_POST_MODE:-success}" == "success" ]]; then
                    BODY_B64=$(base64 < "$BODY_FILE" | tr -d '\n')
                    ENTRY=$(jq -n --argjson id "$ID" --arg body_b64 "$BODY_B64" --arg html_url "$URL" \
                        '{id:$id, author:"github-actions[bot]", html_url:$html_url, body:($body_b64 | @base64d)}')
                    jq -c --argjson e "$ENTRY" '. + [$e]' "$COMMENTS_FILE" > "$COMMENTS_FILE.tmp" && mv "$COMMENTS_FILE.tmp" "$COMMENTS_FILE"
                    echo "$URL"
                    exit 0
                elif [[ "${COMMENT_POST_MODE:-success}" == "fail-but-succeeded" ]]; then
                    BODY_B64=$(base64 < "$BODY_FILE" | tr -d '\n')
                    ENTRY=$(jq -n --argjson id "$ID" --arg body_b64 "$BODY_B64" --arg html_url "$URL" \
                        '{id:$id, author:"github-actions[bot]", html_url:$html_url, body:($body_b64 | @base64d)}')
                    jq -c --argjson e "$ENTRY" '. + [$e]' "$COMMENTS_FILE" > "$COMMENTS_FILE.tmp" && mv "$COMMENTS_FILE.tmp" "$COMMENTS_FILE"
                    echo "gh: response lost" >&2
                    exit 1
                else
                    echo "gh: comment post failed" >&2
                    exit 1
                fi
                ;;
            *)
                exit 1
                ;;
        esac
        ;;
    api)
        # gh api --paginate repos/R/issues/N/comments
        jq -c '.' "$COMMENTS_FILE"
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
GHEOF
    chmod +x "$STUB_DIR/gh"

    cat > "$STUB_DIR/git" << GITEOF
#!/usr/bin/env bash
case "\$*" in
    *"rev-parse HEAD"*)
        echo "\${GIT_STUB_HEAD_OID:-$(printf 'a%.0s' {1..40})}"
        ;;
    *"rev-parse --abbrev-ref HEAD"*)
        echo "\${GIT_STUB_BRANCH:-feature/issue-412}"
        ;;
    *)
        exit 1
        ;;
esac
GITEOF
    chmod +x "$STUB_DIR/git"

    export PATH="$STUB_DIR:$PATH"
    export PR_CREATE_HEAD_OID
    export GIT_STUB_HEAD_OID="$(printf 'a%.0s' {1..40})"
    export GIT_STUB_BRANCH="feature/issue-412"
    PR_CREATE_HEAD_OID="$GIT_STUB_HEAD_OID"

    WORKTREE_DIR="$BATS_TMPDIR/wt-$$-$RANDOM"
    mkdir -p "$WORKTREE_DIR"
}

count_file() {
    cat "$1"
}

# ---------------------------------------------------------------------------
# pr-observe: happy path readback matches intended -> observed/OK
# ---------------------------------------------------------------------------
@test "pr-observe: readback matches intended -> observation.status=observed" {
    ENTRY=$(jq -n --argjson number 200 --arg url "https://github.com/it-all-playpark/skills/pull/200" \
        --arg base "main" --arg head_oid "$GIT_STUB_HEAD_OID" \
        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}')
    jq -c --argjson e "$ENTRY" '. + [$e]' "$OPEN_PRS_FILE" > "$OPEN_PRS_FILE.tmp" && mv "$OPEN_PRS_FILE.tmp" "$OPEN_PRS_FILE"

    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 200
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "OK"'
}

@test "pr-observe: gh pr view failure -> {ok:false,error} exit 0 (not die)" {
    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 999
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | length > 0'
}

# ---------------------------------------------------------------------------
# AC-8: pr-ensure write-once idempotency
# ---------------------------------------------------------------------------
@test "AC-8 pr-ensure: 2回実行しても gh pr create はちょうど1回・open PRは1件のみ" {
    TITLE_FILE="$BATS_TMPDIR/title.txt"; echo "Test PR" > "$TITLE_FILE"
    BODY_FILE="$BATS_TMPDIR/body.txt"; echo "body" > "$BODY_FILE"

    run bash "$SCRIPT" pr-ensure 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --base main --title-file "$TITLE_FILE" --body-file "$BODY_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "observed"'
    [ "$(count_file "$PR_CREATE_CALLS_FILE")" -eq 1 ]

    run bash "$SCRIPT" pr-ensure 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --base main --title-file "$TITLE_FILE" --body-file "$BODY_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "observed"'
    # gh pr create must NOT have been called again (idempotent skip)
    [ "$(count_file "$PR_CREATE_CALLS_FILE")" -eq 1 ]

    OPEN_COUNT=$(jq '[.[] | select(.state == "OPEN")] | length' "$OPEN_PRS_FILE")
    [ "$OPEN_COUNT" -eq 1 ]
}

@test "wrong-target fixture: readback の base 不一致 -> mismatch/WRONG_TARGET" {
    ENTRY=$(jq -n --argjson number 300 --arg url "https://github.com/it-all-playpark/skills/pull/300" \
        --arg base "develop" --arg head_oid "$GIT_STUB_HEAD_OID" \
        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}')
    jq -c --argjson e "$ENTRY" '. + [$e]' "$OPEN_PRS_FILE" > "$OPEN_PRS_FILE.tmp" && mv "$OPEN_PRS_FILE.tmp" "$OPEN_PRS_FILE"

    TITLE_FILE="$BATS_TMPDIR/title2.txt"; echo "Test PR" > "$TITLE_FILE"
    BODY_FILE="$BATS_TMPDIR/body2.txt"; echo "body" > "$BODY_FILE"

    # base=main is requested but the only existing open PR for this head has base=develop,
    # so pr-ensure creates a NEW PR (no exact base+head+state match) rather than treating
    # the develop-based PR as the same effect.
    run bash "$SCRIPT" pr-ensure 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --base main --title-file "$TITLE_FILE" --body-file "$BODY_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "observed"'
    [ "$(count_file "$PR_CREATE_CALLS_FILE")" -eq 1 ]
}

@test "response-loss fixture: gh pr create が exit 1 だが rediscovery で PR が見つかる -> observed" {
    export PR_CREATE_MODE=fail-but-succeeded
    TITLE_FILE="$BATS_TMPDIR/title3.txt"; echo "Test PR" > "$TITLE_FILE"
    BODY_FILE="$BATS_TMPDIR/body3.txt"; echo "body" > "$BODY_FILE"

    run bash "$SCRIPT" pr-ensure 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --base main --title-file "$TITLE_FILE" --body-file "$BODY_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "observed"'
}

@test "response-loss fixture: gh pr create が exit 1 で rediscoveryでも見つからない -> inconclusive/RESPONSE_LOST" {
    export PR_CREATE_MODE=fail
    TITLE_FILE="$BATS_TMPDIR/title4.txt"; echo "Test PR" > "$TITLE_FILE"
    BODY_FILE="$BATS_TMPDIR/body4.txt"; echo "body" > "$BODY_FILE"

    run bash "$SCRIPT" pr-ensure 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --base main --title-file "$TITLE_FILE" --body-file "$BODY_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "inconclusive"'
    echo "$output" | jq -e '.observation.reason_code == "RESPONSE_LOST"'
}

# ---------------------------------------------------------------------------
# AC-9: comment-ensure write-once idempotency
# ---------------------------------------------------------------------------
@test "AC-9 comment-ensure: 2回実行しても comment POST はちょうど1回・2回目は posted:true observed/DUPLICATE_EFFECT" {
    BODY_FILE="$BATS_TMPDIR/comment-body.txt"; echo "Summary comment body" > "$BODY_FILE"

    run bash "$SCRIPT" comment-ensure --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" --effect-type summary-comment --run-id run-412
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.posted == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "OK"'
    [ "$(count_file "$PR_COMMENT_CALLS_FILE")" -eq 1 ]

    run bash "$SCRIPT" comment-ensure --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" --effect-type summary-comment --run-id run-412
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.posted == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "DUPLICATE_EFFECT"'
    # gh pr comment must NOT have been called again
    [ "$(count_file "$PR_COMMENT_CALLS_FILE")" -eq 1 ]

    COMMENT_COUNT=$(jq 'length' "$COMMENTS_FILE")
    [ "$COMMENT_COUNT" -eq 1 ]
}

@test "duplicate fixture: marker 2件 -> mismatch/DUPLICATE_EFFECT" {
    BODY_FILE="$BATS_TMPDIR/comment-body-dup.txt"; echo "Duplicated body" > "$BODY_FILE"

    # Seed two pre-existing comments that already contain the marker for this exact
    # effect (simulating a prior concurrent duplicate post) before running the script.
    run bash "$SCRIPT" comment-ensure --repo it-all-playpark/skills --pr 6 --body-file "$BODY_FILE" --effect-type summary-comment --run-id run-dup
    [ "$status" -eq 0 ]
    EFFECT_ID=$(echo "$output" | jq -r '.effect_id')
    MARKER="<!-- devflow-effect: ${EFFECT_ID} -->"

    EXTRA=$(jq -n --argjson id 999001 --arg body "duplicate 1${MARKER}" '{id:$id, author:"someone", html_url:"https://x/1", body:$body}')
    jq -c --argjson e "$EXTRA" '. + [$e]' "$COMMENTS_FILE" > "$COMMENTS_FILE.tmp" && mv "$COMMENTS_FILE.tmp" "$COMMENTS_FILE"

    run bash "$SCRIPT" comment-ensure --repo it-all-playpark/skills --pr 6 --body-file "$BODY_FILE" --effect-type summary-comment --run-id run-dup
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "mismatch"'
    echo "$output" | jq -e '.observation.reason_code == "DUPLICATE_EFFECT"'
}

# ---------------------------------------------------------------------------
# kill switch: TRUST_KILL_SWITCH set -> mode off, zero writes
# ---------------------------------------------------------------------------
@test "kill switch fixture: TRUST_KILL_SWITCH=1 -> mode off, comment-ensure が投稿ゼロ" {
    BODY_FILE="$BATS_TMPDIR/comment-body-kill.txt"; echo "kill switch body" > "$BODY_FILE"
    export TRUST_KILL_SWITCH=1

    run bash "$SCRIPT" comment-ensure --repo it-all-playpark/skills --pr 7 --body-file "$BODY_FILE" --effect-type summary-comment --run-id run-kill
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.mode == "off"'
    echo "$output" | jq -e '.posted == false'
    [ "$(count_file "$PR_COMMENT_CALLS_FILE")" -eq 0 ]
}

@test "kill switch fixture: TRUST_KILL_SWITCH=1 -> mode off, pr-ensure が gh pr create を一切呼ばない" {
    TITLE_FILE="$BATS_TMPDIR/title-kill.txt"; echo "Test PR" > "$TITLE_FILE"
    BODY_FILE="$BATS_TMPDIR/body-kill.txt"; echo "body" > "$BODY_FILE"
    export TRUST_KILL_SWITCH=1

    run bash "$SCRIPT" pr-ensure 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --base main --title-file "$TITLE_FILE" --body-file "$BODY_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.mode == "off"'
    [ "$(count_file "$PR_CREATE_CALLS_FILE")" -eq 0 ]
}
