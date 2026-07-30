#!/usr/bin/env bats
# Tests for _shared/scripts/effectdelta-github.sh (issue #412, #390 Phase 4;
# refactored to a pure file-input transform in issue #466).
#
# Strategy: this script performs no `gh` I/O of its own — callers (subagents)
# run bare `gh`/`git` commands and hand their stdout/stderr to the script as
# fixture files. So these tests build fixture JSON files directly (no `gh`
# stub) and drive the script's file-input flags. A real local git repo is used
# for the worktree fixture since pr-observe still runs local read-only
# `git -C <worktree> rev-parse` (kept in-script, see issue #466 plan).
#
# Covers: AC-8-equivalent (PR observe wrong-target/probe-failure), AC-9-equivalent
# (comment write-once idempotency via pre/post snapshot classification,
# duplicate, response-lost), kill switch (mode off, zero out-body writes).

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/effectdelta-github.sh"

    unset TRUST_KILL_SWITCH

    WORKTREE_DIR="$BATS_TMPDIR/wt-$$-$RANDOM"
    mkdir -p "$WORKTREE_DIR"
    git -C "$WORKTREE_DIR" init -q
    git -C "$WORKTREE_DIR" config user.email "test@example.com"
    git -C "$WORKTREE_DIR" config user.name "Test"
    echo "seed" > "$WORKTREE_DIR/seed.txt"
    git -C "$WORKTREE_DIR" add seed.txt
    git -C "$WORKTREE_DIR" commit -q -m "seed"
    HEAD_OID="$(git -C "$WORKTREE_DIR" rev-parse HEAD)"
}

# ---------------------------------------------------------------------------
# pr-observe: happy path readback matches intended -> observed/OK
# ---------------------------------------------------------------------------
@test "pr-observe: readback matches intended -> observation.status=observed" {
    VIEW_FILE="$BATS_TMPDIR/view-200.json"
    jq -n --argjson number 200 --arg url "https://github.com/it-all-playpark/skills/pull/200" \
        --arg base "main" --arg head_oid "$HEAD_OID" \
        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}' > "$VIEW_FILE"
    LIST_FILE="$BATS_TMPDIR/list-200.json"
    jq -n --argjson number 200 --arg url "https://github.com/it-all-playpark/skills/pull/200" \
        --arg base "main" --arg head_oid "$HEAD_OID" \
        '[{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}]' > "$LIST_FILE"

    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 200 --base main \
        --pr-view-json "$VIEW_FILE" --pr-list-json "$LIST_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "OK"'
}

@test "pr-observe: --pr-view-err -> {ok:false,error} exit 0 (not die)" {
    ERR_FILE="$BATS_TMPDIR/view-err-999.txt"
    echo "pull request #999 not found" > "$ERR_FILE"

    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 999 --base main \
        --pr-view-err "$ERR_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | contains("pr view readback failed")'
}

# intended.base は呼び出し元の意図値（--base）から取る。readback 由来にすると base 照合が
# 恒真になり、base 起因の WRONG_TARGET が構造的に検出不能になる（PR #417 レビュー指摘）。
@test "pr-observe: readback の base が intended.base(--base) と不一致 -> mismatch/WRONG_TARGET" {
    VIEW_FILE="$BATS_TMPDIR/view-301.json"
    jq -n --argjson number 301 --arg url "https://github.com/it-all-playpark/skills/pull/301" \
        --arg base "develop" --arg head_oid "$HEAD_OID" \
        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}' > "$VIEW_FILE"

    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 301 --base main \
        --pr-view-json "$VIEW_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.observation.status == "mismatch"'
    echo "$output" | jq -e '.observation.reason_code == "WRONG_TARGET"'
}

@test "pr-observe: --pr-list-json 省略時は candidates=null -> readback 一致でも matchCount!=1 で mismatch/WRONG_TARGET" {
    VIEW_FILE="$BATS_TMPDIR/view-210.json"
    jq -n --argjson number 210 --arg url "https://github.com/it-all-playpark/skills/pull/210" \
        --arg base "main" --arg head_oid "$HEAD_OID" \
        '{number:$number, url:$url, baseRefName:$base, headRefOid:$head_oid, state:"OPEN"}' > "$VIEW_FILE"

    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 210 --base main \
        --pr-view-json "$VIEW_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "mismatch"'
    echo "$output" | jq -e '.observation.reason_code == "WRONG_TARGET"'
}

@test "pr-observe: --base 未指定は usage error (readback からの導出へ暗黙 fallback しない)" {
    VIEW_FILE="$BATS_TMPDIR/view-200b.json"
    echo '{}' > "$VIEW_FILE"
    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 200 --pr-view-json "$VIEW_FILE"
    [ "$status" -ne 0 ]
    [[ "$output" == *"--base required"* ]]
}

@test "pr-observe: --repo 未指定は usage error (gh repo view fallback を撤去)" {
    VIEW_FILE="$BATS_TMPDIR/view-200c.json"
    echo '{}' > "$VIEW_FILE"
    run bash "$SCRIPT" pr-observe 412 --worktree "$WORKTREE_DIR" --pr 200 --base main --pr-view-json "$VIEW_FILE"
    [ "$status" -ne 0 ]
    [[ "$output" == *"--repo required"* ]]
}

@test "pr-observe: --pr-view-json / --pr-view-err のどちらも未指定は usage error" {
    run bash "$SCRIPT" pr-observe 412 --repo it-all-playpark/skills --worktree "$WORKTREE_DIR" --pr 200 --base main
    [ "$status" -ne 0 ]
    [[ "$output" == *"--pr-view-json or --pr-view-err"* ]]
}

# ---------------------------------------------------------------------------
# comment-prepare
# ---------------------------------------------------------------------------
@test "comment-prepare: mode off -> byte-identical short-circuit output, out-body not written" {
    BODY_FILE="$BATS_TMPDIR/comment-body-kill.txt"; echo "kill switch body" > "$BODY_FILE"
    OUT_BODY="$BATS_TMPDIR/out-body-kill.md"
    export TRUST_KILL_SWITCH=1

    run bash "$SCRIPT" comment-prepare --repo it-all-playpark/skills --pr 7 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-kill --out-body "$OUT_BODY"
    [ "$status" -eq 0 ]
    [ "$output" = '{"ok":true,"mode":"off","op":"comment-ensure","posted":false}' ]
    [ ! -f "$OUT_BODY" ]
}

@test "comment-prepare: normal mode -> effect_id/marker derived, out-body has marker appended" {
    BODY_FILE="$BATS_TMPDIR/comment-body-prep.txt"; echo "Summary comment body" > "$BODY_FILE"
    OUT_BODY="$BATS_TMPDIR/out-body-prep.md"

    run bash "$SCRIPT" comment-prepare --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-412 --out-body "$OUT_BODY"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.mode == "shadow"'
    EFFECT_ID=$(echo "$output" | jq -r '.effect_id')
    [ -n "$EFFECT_ID" ]
    MARKER=$(echo "$output" | jq -r '.marker')
    [[ "$MARKER" == "<!-- devflow-effect: ${EFFECT_ID} -->" ]]
    [ -f "$OUT_BODY" ]
    grep -qF "Summary comment body" "$OUT_BODY"
    grep -qF "$MARKER" "$OUT_BODY"
}

@test "comment-prepare: --out-body 未指定は usage error" {
    BODY_FILE="$BATS_TMPDIR/comment-body-noout.txt"; echo "body" > "$BODY_FILE"
    run bash "$SCRIPT" comment-prepare --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-412
    [ "$status" -ne 0 ]
    [[ "$output" == *"--out-body required"* ]]
}

# ---------------------------------------------------------------------------
# comment-observe: AC-9-equivalent write-once idempotency (via caller-supplied
# pre/post comment listing snapshots instead of a live post)
# ---------------------------------------------------------------------------
@test "AC-9 comment-observe: post-listing に投稿発見 -> observed/OK、再度 pre-listing 発見 -> observed/DUPLICATE_EFFECT" {
    BODY_FILE="$BATS_TMPDIR/comment-body.txt"; echo "Summary comment body" > "$BODY_FILE"
    OUT_BODY="$BATS_TMPDIR/out-body-ac9.md"

    run bash "$SCRIPT" comment-prepare --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-412 --out-body "$OUT_BODY"
    [ "$status" -eq 0 ]

    # --rawfile (not $(cat ...)) to preserve OUT_BODY's exact bytes (including
    # trailing newline) — the script's expected_body_digest is computed from
    # the same bytes, so a stripped newline would make digests diverge.
    PRE_FILE="$BATS_TMPDIR/pre-ac9.json"; echo '[]' > "$PRE_FILE"
    POST_FILE="$BATS_TMPDIR/post-ac9.json"
    jq -n --rawfile body "$OUT_BODY" \
        '[{id:9001, user:{login:"github-actions[bot]"}, html_url:"https://github.com/it-all-playpark/skills/pull/5#issuecomment-9001", body:$body}]' \
        > "$POST_FILE"

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-412 --pre-comments-json "$PRE_FILE" --post-comments-json "$POST_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.posted == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "OK"'

    PRE_FILE2="$BATS_TMPDIR/pre2-ac9.json"
    jq -n --rawfile body "$OUT_BODY" \
        '[{id:9001, user:{login:"github-actions[bot]"}, html_url:"https://github.com/it-all-playpark/skills/pull/5#issuecomment-9001", body:$body}]' \
        > "$PRE_FILE2"

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 5 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-412 --pre-comments-json "$PRE_FILE2"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.posted == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "DUPLICATE_EFFECT"'
}

@test "duplicate fixture: pre-listing に marker 2件 -> mismatch/DUPLICATE_EFFECT" {
    BODY_FILE="$BATS_TMPDIR/comment-body-dup.txt"; echo "Duplicated body" > "$BODY_FILE"
    OUT_BODY="$BATS_TMPDIR/out-body-dup.md"

    run bash "$SCRIPT" comment-prepare --repo it-all-playpark/skills --pr 6 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-dup --out-body "$OUT_BODY"
    [ "$status" -eq 0 ]
    MARKER=$(echo "$output" | jq -r '.marker')

    PRE_FILE="$BATS_TMPDIR/pre-dup.json"
    jq -n --arg body1 "duplicate 1${MARKER}" --arg body2 "duplicate 2${MARKER}" \
        '[{id:999001, user:{login:"someone"}, html_url:"https://x/1", body:$body1},
          {id:999002, user:{login:"someone"}, html_url:"https://x/2", body:$body2}]' \
        > "$PRE_FILE"

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 6 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-dup --pre-comments-json "$PRE_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "mismatch"'
    echo "$output" | jq -e '.observation.reason_code == "DUPLICATE_EFFECT"'
}

@test "response-lost fixture: --response-lost かつ post-listing でも rediscovery できない -> inconclusive/RESPONSE_LOST" {
    BODY_FILE="$BATS_TMPDIR/comment-body-lost.txt"; echo "Lost body" > "$BODY_FILE"
    PRE_FILE="$BATS_TMPDIR/pre-lost.json"; echo '[]' > "$PRE_FILE"

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 8 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-lost --pre-comments-json "$PRE_FILE" --response-lost
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.observation.status == "inconclusive"'
    echo "$output" | jq -e '.observation.reason_code == "RESPONSE_LOST"'
}

@test "response-lost fixture: --response-lost だが post-listing で rediscovery できた -> observed/OK" {
    BODY_FILE="$BATS_TMPDIR/comment-body-relost.txt"; echo "Recovered body" > "$BODY_FILE"
    OUT_BODY="$BATS_TMPDIR/out-body-relost.md"

    run bash "$SCRIPT" comment-prepare --repo it-all-playpark/skills --pr 9 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-relost --out-body "$OUT_BODY"
    [ "$status" -eq 0 ]

    PRE_FILE="$BATS_TMPDIR/pre-relost.json"; echo '[]' > "$PRE_FILE"
    POST_FILE="$BATS_TMPDIR/post-relost.json"
    jq -n --rawfile body "$OUT_BODY" \
        '[{id:9100, user:{login:"github-actions[bot]"}, html_url:"https://github.com/it-all-playpark/skills/pull/9#issuecomment-9100", body:$body}]' \
        > "$POST_FILE"

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 9 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-relost --pre-comments-json "$PRE_FILE" \
        --post-comments-json "$POST_FILE" --response-lost
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.posted == true'
    echo "$output" | jq -e '.observation.status == "observed"'
    echo "$output" | jq -e '.observation.reason_code == "OK"'
}

@test "comment-observe: --pre-comments-err -> {ok:false,error} exit 0 (not die)" {
    BODY_FILE="$BATS_TMPDIR/comment-body-err.txt"; echo "body" > "$BODY_FILE"
    ERR_FILE="$BATS_TMPDIR/pre-err.txt"; echo "API rate limit exceeded" > "$ERR_FILE"

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 10 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-err --pre-comments-err "$ERR_FILE"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | contains("comments listing failed (pre-post discovery)")'
}

@test "comment-observe: --pre-comments-json / --pre-comments-err のどちらも未指定は usage error" {
    BODY_FILE="$BATS_TMPDIR/comment-body-noargs.txt"; echo "body" > "$BODY_FILE"
    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 10 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-noargs
    [ "$status" -ne 0 ]
    [[ "$output" == *"--pre-comments-json or --pre-comments-err"* ]]
}

@test "comment-observe: mode off -> byte-identical short-circuit output even with pre-comments-json supplied" {
    BODY_FILE="$BATS_TMPDIR/comment-body-obskill.txt"; echo "body" > "$BODY_FILE"
    PRE_FILE="$BATS_TMPDIR/pre-obskill.json"; echo '[]' > "$PRE_FILE"
    export TRUST_KILL_SWITCH=1

    run bash "$SCRIPT" comment-observe --repo it-all-playpark/skills --pr 11 --body-file "$BODY_FILE" \
        --effect-type summary-comment --run-id run-obskill --pre-comments-json "$PRE_FILE"
    [ "$status" -eq 0 ]
    [ "$output" = '{"ok":true,"mode":"off","op":"comment-ensure","posted":false}' ]
}
