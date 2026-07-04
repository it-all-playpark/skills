#!/usr/bin/env bats
# Tests for skill-retrospective/scripts/journal.sh
# Focus: telemetry fields (--merge-tier, --gate-policy, --danger-hits) in cmd_log.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/skill-retrospective/scripts/journal.sh"

    # Isolate journal output to a temp directory for each test
    export CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
}

# Helper: get the most recently written journal JSON file
latest_entry() {
    # Find the most recent .json file in CLAUDE_JOURNAL_DIR
    ls -t "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | head -n 1
}

# ---------------------------------------------------------------------------
# Test 1: All three telemetry options are recorded
# ---------------------------------------------------------------------------
@test "all three telemetry options recorded correctly" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --gate-policy llm-major-advisory \
        --danger-hits '["auth","crypto"]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    gate_policy=$(jq -r '.telemetry.gate_policy' "$entry_file")
    danger_hits=$(jq -c '.telemetry.danger_hits' "$entry_file")

    [ "$merge_tier" = "REVIEW" ]
    [ "$gate_policy" = "llm-major-advisory" ]
    [ "$danger_hits" = '["auth","crypto"]' ]
}

# ---------------------------------------------------------------------------
# Test 2: No telemetry options -> no .telemetry key in entry
# ---------------------------------------------------------------------------
@test "no telemetry options -> no telemetry key in entry" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 3: Only --merge-tier -> .telemetry.merge_tier recorded,
#          gate_policy and danger_hits keys absent
# ---------------------------------------------------------------------------
@test "only --merge-tier -> telemetry.merge_tier present, others absent" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    # merge_tier must be present
    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]

    # gate_policy and danger_hits must be absent
    has_gate_policy=$(jq '.telemetry | has("gate_policy")' "$entry_file")
    has_danger_hits=$(jq '.telemetry | has("danger_hits")' "$entry_file")
    [ "$has_gate_policy" = "false" ]
    [ "$has_danger_hits" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 4: All 6 new telemetry fields recorded with correct types
# ---------------------------------------------------------------------------
@test "all 6 new telemetry fields recorded with correct types" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --shape standard \
        --shape-refloored false \
        --eval-verdict pass \
        --iterate-status lgtm \
        --plan-iter 2 \
        --eval-iter 1
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    shape=$(jq -r '.telemetry.shape' "$entry_file")
    eval_verdict=$(jq -r '.telemetry.eval_verdict' "$entry_file")
    iterate_status=$(jq -r '.telemetry.iterate_status' "$entry_file")

    [ "$shape" = "standard" ]
    [ "$eval_verdict" = "pass" ]
    [ "$iterate_status" = "lgtm" ]

    # shape_refloored must be boolean false (not string "false")
    shape_refloored_type=$(jq '.telemetry.shape_refloored | type' "$entry_file")
    [ "$shape_refloored_type" = '"boolean"' ]

    shape_refloored_val=$(jq '.telemetry.shape_refloored' "$entry_file")
    [ "$shape_refloored_val" = "false" ]

    # plan_iter and eval_iter must be numbers
    plan_iter_type=$(jq '.telemetry.plan_iter | type' "$entry_file")
    [ "$plan_iter_type" = '"number"' ]

    eval_iter_type=$(jq '.telemetry.eval_iter | type' "$entry_file")
    [ "$eval_iter_type" = '"number"' ]

    plan_iter_val=$(jq '.telemetry.plan_iter' "$entry_file")
    [ "$plan_iter_val" = "2" ]

    eval_iter_val=$(jq '.telemetry.eval_iter' "$entry_file")
    [ "$eval_iter_val" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 5: --shape-refloored false is recorded as boolean false, not string
# ---------------------------------------------------------------------------
@test "--shape-refloored false is boolean false not string" {
    run "$SCRIPT" log dev-flow success --shape-refloored false
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    shape_refloored_type=$(jq '.telemetry.shape_refloored | type' "$entry_file")
    [ "$shape_refloored_type" = '"boolean"' ]

    shape_refloored_val=$(jq '.telemetry.shape_refloored' "$entry_file")
    [ "$shape_refloored_val" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 6: --shape-refloored with invalid value exits non-zero
# ---------------------------------------------------------------------------
@test "--shape-refloored yes exits non-zero" {
    run "$SCRIPT" log dev-flow success --shape-refloored yes
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test 7: --plan-iter with non-numeric value exits non-zero
# ---------------------------------------------------------------------------
@test "--plan-iter abc exits non-zero" {
    run "$SCRIPT" log dev-flow success --plan-iter abc
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test 8: Partial new flags - only specified keys present, others absent
# ---------------------------------------------------------------------------
@test "only --iterate-status specified -> only that key present among new 6" {
    run "$SCRIPT" log dev-flow success --iterate-status lgtm
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    iterate_status=$(jq -r '.telemetry.iterate_status' "$entry_file")
    [ "$iterate_status" = "lgtm" ]

    # The other 5 new keys must be absent
    has_shape=$(jq '.telemetry | has("shape")' "$entry_file")
    has_shape_refloored=$(jq '.telemetry | has("shape_refloored")' "$entry_file")
    has_eval_verdict=$(jq '.telemetry | has("eval_verdict")' "$entry_file")
    has_plan_iter=$(jq '.telemetry | has("plan_iter")' "$entry_file")
    has_eval_iter=$(jq '.telemetry | has("eval_iter")' "$entry_file")

    [ "$has_shape" = "false" ]
    [ "$has_shape_refloored" = "false" ]
    [ "$has_eval_verdict" = "false" ]
    [ "$has_plan_iter" = "false" ]
    [ "$has_eval_iter" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 9: Existing 3 flags only -> new 6 keys absent
# ---------------------------------------------------------------------------
@test "existing 3 telemetry flags only -> new 6 keys absent" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --gate-policy llm-major-advisory \
        --danger-hits '[]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_shape=$(jq '.telemetry | has("shape")' "$entry_file")
    has_shape_refloored=$(jq '.telemetry | has("shape_refloored")' "$entry_file")
    has_eval_verdict=$(jq '.telemetry | has("eval_verdict")' "$entry_file")
    has_iterate_status=$(jq '.telemetry | has("iterate_status")' "$entry_file")
    has_plan_iter=$(jq '.telemetry | has("plan_iter")' "$entry_file")
    has_eval_iter=$(jq '.telemetry | has("eval_iter")' "$entry_file")

    [ "$has_shape" = "false" ]
    [ "$has_shape_refloored" = "false" ]
    [ "$has_eval_verdict" = "false" ]
    [ "$has_iterate_status" = "false" ]
    [ "$has_plan_iter" = "false" ]
    [ "$has_eval_iter" = "false" ]
}

# ---------------------------------------------------------------------------
# Tests for --eval-staleness (issue #288)
# ---------------------------------------------------------------------------

@test "--eval-staleness hash_mismatch recorded as string" {
    run "$SCRIPT" log dev-flow success --eval-staleness hash_mismatch
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    eval_staleness=$(jq -r '.telemetry.eval_staleness' "$entry_file")
    [ "$eval_staleness" = "hash_mismatch" ]

    eval_staleness_type=$(jq '.telemetry.eval_staleness | type' "$entry_file")
    [ "$eval_staleness_type" = '"string"' ]
}

@test "--eval-staleness none recorded correctly" {
    run "$SCRIPT" log dev-flow success --eval-staleness none
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    eval_staleness=$(jq -r '.telemetry.eval_staleness' "$entry_file")
    [ "$eval_staleness" = "none" ]
}

@test "--eval-staleness bogus exits non-zero (out-of-enum rejection)" {
    run "$SCRIPT" log dev-flow success --eval-staleness bogus
    [ "$status" -ne 0 ]
}

@test "no --eval-staleness and no other telemetry -> no telemetry key" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ===========================================================================
# Tests for new features: source field, atomic write, --source filter, iconv
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (a): log で書いたエントリに source == "skill" がある
# ---------------------------------------------------------------------------
@test "log entry has source == skill" {
    run "$SCRIPT" log test-skill success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    source_val=$(jq -r '.source' "$entry_file")
    [ "$source_val" = "skill" ]
}

# ---------------------------------------------------------------------------
# Test (b): hook-capture で書いたエントリに source == "hook" がある
# ---------------------------------------------------------------------------
@test "hook-capture entry has source == hook" {
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    source_val=$(jq -r '.source' "$entry_file")
    [ "$source_val" = "hook" ]
}

# ---------------------------------------------------------------------------
# Test (c): 同一秒 2 回書き込みで 2 ファイル存在し両方 jq empty を通る
# (現実装: ファイル名衝突で 1 ファイルに上書きされ red)
# ---------------------------------------------------------------------------
@test "concurrent writes in same second produce 2 valid JSON files" {
    # stub date: 引数を無視して固定時刻を返す
    stub_dir="$BATS_TMPDIR/stub-date-$$"
    mkdir -p "$stub_dir"
    cat > "$stub_dir/date" <<'STUB'
#!/usr/bin/env bash
# Stub date: always return fixed timestamp regardless of args
if [[ "$*" == *"+%s"* ]]; then
    echo "1749600000"
else
    echo "2026-06-11T00:00:00Z"
fi
STUB
    chmod +x "$stub_dir/date"

    run bash -c "PATH='$stub_dir:$PATH' '$SCRIPT' log test-skill success"
    [ "$status" -eq 0 ]
    run bash -c "PATH='$stub_dir:$PATH' '$SCRIPT' log test-skill success"
    [ "$status" -eq 0 ]

    # 2 ファイルが存在すること
    count=$(ls "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
    [ "$count" -eq 2 ]

    # 両ファイルが valid JSON であること
    for f in "$CLAUDE_JOURNAL_DIR"/*.json; do
        run jq empty "$f"
        [ "$status" -eq 0 ]
    done
}

# ---------------------------------------------------------------------------
# Test (d): 制御文字 regression pin
# --error-msg に制御文字を含む値を渡しても jq empty が通り生制御バイトが無い
# NOTE: jq --arg が既にエスケープするためこのテストは最初から green になる。
#       regression pin として残す（将来の変更で壊れないことを確認するため）。
# ---------------------------------------------------------------------------
@test "regression pin: control chars in error-msg produce valid JSON (jq --arg escapes them)" {
    # $'...' はテストランナー (bash) が展開する
    error_with_ctrl=$'line1\x01\x02\ttab'
    run "$SCRIPT" log test-skill failure \
        --error-category runtime \
        --error-msg "$error_with_ctrl"
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    # ファイルが valid JSON であること
    run jq empty "$entry_file"
    [ "$status" -eq 0 ]

    # 生制御バイト \x01 が含まれていないこと
    raw_ctrl_count=$(LC_ALL=C grep -c $'\x01' "$entry_file" || true)
    [ "$raw_ctrl_count" -eq 0 ]

    # jq -s で複数ファイルをまとめて読めること
    run jq -s '.' "$CLAUDE_JOURNAL_DIR"/*.json
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test (e): query --source skill が hook エントリを除外し、source 欠落エントリを含む
# ---------------------------------------------------------------------------
@test "query --source skill excludes hook entries and includes entries without source" {
    # hook エントリを書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    # skill エントリを書く
    run "$SCRIPT" log my-skill success
    [ "$status" -eq 0 ]

    # source 欠落エントリを手書きで配置（後方互換確認）
    cat > "$CLAUDE_JOURNAL_DIR/2026-06-11-00-00-01-legacy.json" <<'JSON'
{"version":"1.0.0","id":"20260611T000001-legacy","timestamp":"2026-06-11T00:00:01Z","skill":"legacy","outcome":"success"}
JSON

    run "$SCRIPT" query --source skill
    [ "$status" -eq 0 ]

    # hook エントリが除外されていること（source == "hook" のエントリが結果に無い）
    hook_count=$(echo "$output" | jq '[.[] | select(.source == "hook")] | length')
    [ "$hook_count" -eq 0 ]

    # skill エントリが含まれること
    skill_count=$(echo "$output" | jq '[.[] | select(.source == "skill")] | length')
    [ "$skill_count" -ge 1 ]

    # source 欠落エントリが含まれること（後方互換: source 欠落は skill 扱い）
    legacy_count=$(echo "$output" | jq '[.[] | select(.skill == "legacy")] | length')
    [ "$legacy_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (f): query --source hook が hook エントリのみ返す
# ---------------------------------------------------------------------------
@test "query --source hook returns only hook entries" {
    # hook エントリを書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    # skill エントリを書く
    run "$SCRIPT" log my-skill success
    [ "$status" -eq 0 ]

    run "$SCRIPT" query --source hook
    [ "$status" -eq 0 ]

    # hook エントリのみ含まれること
    total=$(echo "$output" | jq 'length')
    hook_count=$(echo "$output" | jq '[.[] | select(.source == "hook")] | length')
    [ "$total" -eq "$hook_count" ]
    [ "$total" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test (g): query --source invalid が非 0 exit
# ---------------------------------------------------------------------------
@test "query --source invalid exits non-zero" {
    run "$SCRIPT" query --source invalid
    [ "$status" -ne 0 ]
}

# ===========================================================================
# Tests for new error categories: needs_clarification, empty_diff (#225)
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (h): --error-category needs_clarification で failure が exit 0 で記録される
# ---------------------------------------------------------------------------
@test "failure with needs_clarification category exits 0 and records entry" {
    run "$SCRIPT" log dev-flow failure \
        --error-category needs_clarification \
        --error-msg 'user clarification needed' \
        --gate-policy llm-major-advisory \
        --plan-iter 1 \
        --eval-iter 0
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    outcome=$(jq -r '.outcome' "$entry_file")
    [ "$outcome" = "failure" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "needs_clarification" ]

    # merge_tier キーが telemetry に無いこと（省略時は含まれない）
    has_merge_tier=$(jq '.telemetry | has("merge_tier")' "$entry_file")
    [ "$has_merge_tier" = "false" ]
}

# ---------------------------------------------------------------------------
# Test (i): --error-category empty_diff で failure が exit 0 で記録される
# ---------------------------------------------------------------------------
@test "failure with empty_diff category exits 0 and records entry" {
    run "$SCRIPT" log dev-flow failure \
        --error-category empty_diff \
        --error-msg 'no changes produced' \
        --gate-policy llm-major-advisory \
        --plan-iter 0 \
        --eval-iter 0
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    outcome=$(jq -r '.outcome' "$entry_file")
    [ "$outcome" = "failure" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "empty_diff" ]

    # merge_tier キーが telemetry に無いこと
    has_merge_tier=$(jq '.telemetry | has("merge_tier")' "$entry_file")
    [ "$has_merge_tier" = "false" ]
}

# ---------------------------------------------------------------------------
# Test (j): --error-category bogus は die_json で失敗（out-of-enum 拒否の回帰）
# ---------------------------------------------------------------------------
@test "failure with bogus category exits non-zero (out-of-enum rejection)" {
    run "$SCRIPT" log dev-flow failure \
        --error-category bogus \
        --error-msg 'some error'
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test (k): failure で --error-msg 欠落は従来どおり失敗
# ---------------------------------------------------------------------------
@test "failure without --error-msg exits non-zero" {
    run "$SCRIPT" log dev-flow failure \
        --error-category needs_clarification
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test (l): 既存 8 カテゴリへの回帰（runtime が引き続き受理される）
# ---------------------------------------------------------------------------
@test "existing category runtime is still accepted" {
    run "$SCRIPT" log dev-flow failure \
        --error-category runtime \
        --error-msg 'runtime error'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "runtime" ]
}

# ===========================================================================
# Tests for --repo / --pr-number (issue #309)
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (m): --repo と --pr-number が context に記録され、telemetry と共存する
# ---------------------------------------------------------------------------
@test "--repo and --pr-number recorded in context and coexist with telemetry" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW --repo acme/skills --pr-number 123
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    repo_val=$(jq -r '.context.repo' "$entry_file")
    [ "$repo_val" = "acme/skills" ]

    pr_number_val=$(jq '.context.pr_number' "$entry_file")
    [ "$pr_number_val" = "123" ]

    pr_number_type=$(jq '.context.pr_number | type' "$entry_file")
    [ "$pr_number_type" = '"number"' ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]
}

# ---------------------------------------------------------------------------
# Test (n): --repo に owner/name 形式でない値（スラッシュ無し）を渡すと exit 1
# ---------------------------------------------------------------------------
@test "--repo without slash exits non-zero with Invalid message" {
    run "$SCRIPT" log dev-flow success --repo acme
    [ "$status" -eq 1 ]
    combined_output="$output"
    [[ "$combined_output" == *"Invalid"* ]]
}

# ---------------------------------------------------------------------------
# Test (o): --pr-number 0 は exit 1
# ---------------------------------------------------------------------------
@test "--pr-number 0 exits non-zero" {
    run "$SCRIPT" log dev-flow success --pr-number 0
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (p): --pr-number abc（非数値）は exit 1
# ---------------------------------------------------------------------------
@test "--pr-number abc exits non-zero" {
    run "$SCRIPT" log dev-flow success --pr-number abc
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (q): --repo / --pr-number 未指定時は context.repo / context.pr_number キーが無い
# ---------------------------------------------------------------------------
@test "no --repo/--pr-number -> context has no repo/pr_number keys" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_repo=$(jq '.context // {} | has("repo")' "$entry_file")
    has_pr_number=$(jq '.context // {} | has("pr_number")' "$entry_file")
    [ "$has_repo" = "false" ]
    [ "$has_pr_number" = "false" ]
}
