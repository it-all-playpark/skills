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

# ---------------------------------------------------------------------------
# Tests for --ci-wait-seconds / --ci-poll-attempts (issue #324, AC-7 journal side)
# ---------------------------------------------------------------------------

@test "--ci-wait-seconds and --ci-poll-attempts recorded as numbers" {
    run "$SCRIPT" log pr-iterate success --ci-wait-seconds 30 --ci-poll-attempts 3
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    ci_wait_ok=$(jq '.telemetry.ci_wait_seconds == 30' "$entry_file")
    [ "$ci_wait_ok" = "true" ]

    ci_poll_ok=$(jq '.telemetry.ci_poll_attempts == 3' "$entry_file")
    [ "$ci_poll_ok" = "true" ]

    ci_wait_type=$(jq '.telemetry.ci_wait_seconds | type' "$entry_file")
    [ "$ci_wait_type" = '"number"' ]

    ci_poll_type=$(jq '.telemetry.ci_poll_attempts | type' "$entry_file")
    [ "$ci_poll_type" = '"number"' ]
}

@test "--ci-wait-seconds 0 recorded as number 0 (key present)" {
    run "$SCRIPT" log pr-iterate success --ci-wait-seconds 0
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_ci_wait=$(jq '.telemetry | has("ci_wait_seconds")' "$entry_file")
    [ "$has_ci_wait" = "true" ]

    ci_wait_ok=$(jq '.telemetry.ci_wait_seconds == 0' "$entry_file")
    [ "$ci_wait_ok" = "true" ]
}

@test "--ci-wait-seconds -1 exits non-zero with Invalid message" {
    run "$SCRIPT" log pr-iterate success --ci-wait-seconds -1
    [ "$status" -ne 0 ]
    [[ "$output" == *"Invalid"* ]]
}

@test "--ci-poll-attempts abc exits non-zero with Invalid message" {
    run "$SCRIPT" log pr-iterate success --ci-poll-attempts abc
    [ "$status" -ne 0 ]
    [[ "$output" == *"Invalid"* ]]
}

@test "only --ci-wait-seconds specified -> only that key present" {
    run "$SCRIPT" log pr-iterate success --ci-wait-seconds 45
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_ci_wait=$(jq '.telemetry | has("ci_wait_seconds")' "$entry_file")
    has_ci_poll=$(jq '.telemetry | has("ci_poll_attempts")' "$entry_file")
    [ "$has_ci_wait" = "true" ]
    [ "$has_ci_poll" = "false" ]
}

@test "no ci telemetry flags and no other telemetry -> no telemetry key (regression)" {
    run "$SCRIPT" log pr-iterate success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

@test "--iterate-status lgtm and --ci-wait-seconds 30 coexist in telemetry" {
    run "$SCRIPT" log pr-iterate success --iterate-status lgtm --ci-wait-seconds 30
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    iterate_status=$(jq -r '.telemetry.iterate_status' "$entry_file")
    [ "$iterate_status" = "lgtm" ]

    ci_wait_ok=$(jq '.telemetry.ci_wait_seconds == 30' "$entry_file")
    [ "$ci_wait_ok" = "true" ]
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
# Tests for stats default source filter (#308): stats defaults to skill-only
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (i): stats のデフォルトが hook エントリを集計から除外する
# ---------------------------------------------------------------------------
@test "stats default excludes hook entries" {
    # skill success エントリを2件書く
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    # hook failure エントリを1件書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats
    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 2 ]

    failure=$(echo "$output" | jq '.failure')
    [ "$failure" -eq 0 ]

    hook_skill_count=$(echo "$output" | jq '[.by_skill[] | select(.skill == "Bash")] | length')
    [ "$hook_skill_count" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test (j): stats --source hook を明示した場合は hook エントリのみ集計する
# ---------------------------------------------------------------------------
@test "stats --source hook returns only hook entries" {
    # skill success エントリを1件書く
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    # hook failure エントリを1件書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats --source hook
    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 1 ]

    failure=$(echo "$output" | jq '.failure')
    [ "$failure" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (k): stats のデフォルトは source フィールド欠落エントリを skill 扱いで含む
# ---------------------------------------------------------------------------
@test "stats default includes entries without source field" {
    # source 欠落エントリを手書きで配置（#201 以前の journal 互換）
    cat > "$CLAUDE_JOURNAL_DIR/2026-06-11-00-00-01-legacy.json" <<'JSON'
{"version":"1.0.0","id":"20260611T000001-legacy","timestamp":"2026-06-11T00:00:01Z","skill":"legacy","outcome":"success"}
JSON

    # skill エントリを1件書く
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats
    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 2 ]
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
# Tests for new error category: cross_repo (issue #432)
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (n): --error-category cross_repo で partial が exit 0 で記録される
# ---------------------------------------------------------------------------
@test "partial with cross_repo category exits 0 and records entry" {
    run "$SCRIPT" log dev-flow partial \
        --error-category cross_repo \
        --error-msg 'x'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    outcome=$(jq -r '.outcome' "$entry_file")
    [ "$outcome" = "partial" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "cross_repo" ]
}

# ---------------------------------------------------------------------------
# Test (o): 未知カテゴリは引き続き die_json で拒否される（enum が閉じたままの回帰確認）
# ---------------------------------------------------------------------------
@test "partial with bogus category still exits non-zero (enum stays closed)" {
    run "$SCRIPT" log dev-flow partial \
        --error-category bogus \
        --error-msg 'some error'
    [ "$status" -ne 0 ]
}

# ===========================================================================
# Tests for new error category: guard_blocked (issue #530)
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (a): --error-category guard_blocked で success が exit 0 で記録される
# ---------------------------------------------------------------------------
@test "success with guard_blocked category exits 0 and records entry" {
    run "$SCRIPT" log dev-flow success \
        --error-category guard_blocked
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "guard_blocked" ]
}

# ---------------------------------------------------------------------------
# Test (b): --error-category guard_blocked で failure が exit 0 で記録される
# ---------------------------------------------------------------------------
@test "failure with guard_blocked category exits 0 and records entry" {
    run "$SCRIPT" log dev-flow failure \
        --error-category guard_blocked \
        --error-msg 'guard blocked the run'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "guard_blocked" ]
    outcome=$(jq -r '.outcome' "$entry_file")
    [ "$outcome" = "failure" ]
}

# ---------------------------------------------------------------------------
# Test (c): 未知カテゴリは guard_blocked 追加後も引き続き die_json で拒否される
# ---------------------------------------------------------------------------
@test "partial with bogus category still exits non-zero after guard_blocked addition" {
    run "$SCRIPT" log dev-flow partial \
        --error-category bogus \
        --error-msg 'x'
    [ "$status" -ne 0 ]
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

# ---------------------------------------------------------------------------
# --telemetry-json (dev-improve improve-cycle telemetry 用の汎用 flag)
# ---------------------------------------------------------------------------
@test "--telemetry-json: 任意 object が telemetry にマージされる" {
    run "$SCRIPT" log dev-improve success \
        --telemetry-json '{"candidates_found":3,"issues_filed":2,"backpressure_skipped":false}'
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    [ -n "$entry_file" ]
    [ "$(jq -r '.telemetry.candidates_found' "$entry_file")" = "3" ]
    [ "$(jq -r '.telemetry.issues_filed' "$entry_file")" = "2" ]
    [ "$(jq -r '.telemetry.backpressure_skipped' "$entry_file")" = "false" ]
}

@test "--telemetry-json: 既存 telemetry flag と併用できる" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --telemetry-json '{"candidates_found":1}'
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    [ "$(jq -r '.telemetry.merge_tier' "$entry_file")" = "REVIEW" ]
    [ "$(jq -r '.telemetry.candidates_found' "$entry_file")" = "1" ]
}

@test "--telemetry-json: JSON でない値は error" {
    run "$SCRIPT" log dev-improve success --telemetry-json 'not-json'
    [ "$status" -ne 0 ]
}

@test "--telemetry-json: object 以外（配列）は error" {
    run "$SCRIPT" log dev-improve success --telemetry-json '[1,2]'
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# trust telemetry (--trust-run-id / --trust-receipts / --trust-surfaceproof)
# dev-flow.js Stop hook 転送を受ける journal 側の受理口 (issue #413)
# ---------------------------------------------------------------------------
@test "trust telemetry: 3 フラグ受理時に telemetry.trust_* へ到達する" {
    run "$SCRIPT" log dev-flow success \
        --trust-run-id "run-abc123" \
        --trust-receipts '[{"layer":"surfaceproof","mode":"shadow","verdict":"pass"},{"layer":"evalseal","mode":"advisory","verdict":"inconclusive"}]' \
        --trust-surfaceproof '{"mode":"shadow","verdict":"pass"}'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    [ "$(jq -r '.telemetry.trust_run_id' "$entry_file")" = "run-abc123" ]
    [ "$(jq -c '.telemetry.trust_receipts' "$entry_file")" = '[{"layer":"surfaceproof","mode":"shadow","verdict":"pass"},{"layer":"evalseal","mode":"advisory","verdict":"inconclusive"}]' ]
    [ "$(jq -c '.telemetry.trust_surfaceproof_shadow' "$entry_file")" = '{"mode":"shadow","verdict":"pass"}' ]
}

@test "trust telemetry: --trust-receipts に非配列 JSON は error" {
    run "$SCRIPT" log dev-flow success --trust-receipts '{"layer":"surfaceproof","mode":"shadow","verdict":"pass"}'
    [ "$status" -ne 0 ]
}

@test "trust telemetry: --trust-receipts の未知 layer は error" {
    run "$SCRIPT" log dev-flow success --trust-receipts '[{"layer":"bogus","mode":"shadow","verdict":"pass"}]'
    [ "$status" -ne 0 ]
}

@test "trust telemetry: --trust-receipts の未知 mode は error" {
    run "$SCRIPT" log dev-flow success --trust-receipts '[{"layer":"surfaceproof","mode":"bogus","verdict":"pass"}]'
    [ "$status" -ne 0 ]
}

@test "trust telemetry: --trust-receipts の未知 verdict は error" {
    run "$SCRIPT" log dev-flow success --trust-receipts '[{"layer":"surfaceproof","mode":"shadow","verdict":"bogus"}]'
    [ "$status" -ne 0 ]
}

@test "trust telemetry: --trust-receipts の欠落フィールドは error" {
    run "$SCRIPT" log dev-flow success --trust-receipts '[{"layer":"surfaceproof","mode":"shadow"}]'
    [ "$status" -ne 0 ]
}

@test "trust telemetry: --trust-surfaceproof の未知 mode/verdict は error" {
    run "$SCRIPT" log dev-flow success --trust-surfaceproof '{"mode":"bogus","verdict":"pass"}'
    [ "$status" -ne 0 ]

    run "$SCRIPT" log dev-flow success --trust-surfaceproof '{"mode":"shadow","verdict":"bogus"}'
    [ "$status" -ne 0 ]
}

@test "trust telemetry: --trust-run-id 空文字は error" {
    run "$SCRIPT" log dev-flow success --trust-run-id ""
    [ "$status" -ne 0 ]
}

@test "trust telemetry: 3 フラグ未指定の既存呼び出しは telemetry に trust キーが現れない" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_run_id=$(jq '.telemetry | has("trust_run_id")' "$entry_file")
    has_receipts=$(jq '.telemetry | has("trust_receipts")' "$entry_file")
    has_surfaceproof=$(jq '.telemetry | has("trust_surfaceproof_shadow")' "$entry_file")
    [ "$has_run_id" = "false" ]
    [ "$has_receipts" = "false" ]
    [ "$has_surfaceproof" = "false" ]
}

# ===========================================================================
# telemetry 8-key flags (issue #430)
# ===========================================================================

# ---------------------------------------------------------------------------
# (a) 8 フラグ全指定 -> 全キーが正しい型で記録される
# ---------------------------------------------------------------------------
@test "8 telemetry flags: all specified are recorded with correct types" {
    run "$SCRIPT" log dev-flow success \
        --vdelta-verdicts '[{"ac":1,"status":"promoted"}]' \
        --vdelta-fail-open 1 \
        --redgreen-deny '[{"ac":2,"reasons":["no red"]}]' \
        --testsurf-hits '[]' \
        --duration-seconds 840 \
        --phase-durations '{"analyze":120}' \
        --merge-tier-reasons '["danger hit"]' \
        --route lite
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    [ "$(jq '.telemetry.vdelta_verdicts | type' "$entry_file")" = '"array"' ]
    [ "$(jq -c '.telemetry.vdelta_verdicts' "$entry_file")" = '[{"ac":1,"status":"promoted"}]' ]

    [ "$(jq '.telemetry.vdelta_fail_open | type' "$entry_file")" = '"number"' ]
    [ "$(jq '.telemetry.vdelta_fail_open' "$entry_file")" = "1" ]

    [ "$(jq '.telemetry.redgreen_deny | type' "$entry_file")" = '"array"' ]
    [ "$(jq -c '.telemetry.redgreen_deny' "$entry_file")" = '[{"ac":2,"reasons":["no red"]}]' ]

    [ "$(jq '.telemetry.testsurf_hits | type' "$entry_file")" = '"array"' ]
    [ "$(jq -c '.telemetry.testsurf_hits' "$entry_file")" = '[]' ]

    [ "$(jq '.telemetry.duration_seconds | type' "$entry_file")" = '"number"' ]
    [ "$(jq '.telemetry.duration_seconds' "$entry_file")" = "840" ]

    [ "$(jq '.telemetry.phase_durations | type' "$entry_file")" = '"object"' ]
    [ "$(jq -c '.telemetry.phase_durations' "$entry_file")" = '{"analyze":120}' ]

    [ "$(jq '.telemetry.merge_tier_reasons | type' "$entry_file")" = '"array"' ]
    [ "$(jq -c '.telemetry.merge_tier_reasons' "$entry_file")" = '["danger hit"]' ]

    [ "$(jq -r '.telemetry.route' "$entry_file")" = "lite" ]
    [ "$(jq '.telemetry.route | type' "$entry_file")" = '"string"' ]
}

# ---------------------------------------------------------------------------
# (b) --route full が "full" で記録される
# ---------------------------------------------------------------------------
@test "8 telemetry flags: --route full recorded as full" {
    run "$SCRIPT" log dev-flow success --route full
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    [ "$(jq -r '.telemetry.route' "$entry_file")" = "full" ]
}

# ---------------------------------------------------------------------------
# (c) --route bogus -> exit 0, base entry 正常, telemetry.route が無い
# ---------------------------------------------------------------------------
@test "8 telemetry flags: --route bogus is dropped, base entry still recorded" {
    run "$SCRIPT" log dev-flow success --route bogus --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    skill_val=$(jq -r '.skill' "$entry_file")
    [ "$skill_val" = "dev-flow" ]
    outcome_val=$(jq -r '.outcome' "$entry_file")
    [ "$outcome_val" = "success" ]

    has_route=$(jq '.telemetry | has("route")' "$entry_file")
    [ "$has_route" = "false" ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]
}

@test "8 telemetry flags: --route bogus alone (no other telemetry) -> no telemetry key" {
    run "$SCRIPT" log dev-flow success --route bogus
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ---------------------------------------------------------------------------
# (d) 各キーの型違反が drop される（個別検証）
# ---------------------------------------------------------------------------
@test "8 telemetry flags: --vdelta-verdicts with non-object element is dropped" {
    run "$SCRIPT" log dev-flow success --vdelta-verdicts '["str"]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("vdelta_verdicts")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: --vdelta-fail-open abc is dropped" {
    run "$SCRIPT" log dev-flow success --vdelta-fail-open abc
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("vdelta_fail_open")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: --redgreen-deny non-array is dropped" {
    run "$SCRIPT" log dev-flow success --redgreen-deny '{}'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("redgreen_deny")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: --testsurf-hits with non-string element is dropped" {
    run "$SCRIPT" log dev-flow success --testsurf-hits '[1]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("testsurf_hits")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: --duration-seconds -5 is dropped" {
    run "$SCRIPT" log dev-flow success --duration-seconds -5
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("duration_seconds")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: --phase-durations with non-number value is dropped" {
    run "$SCRIPT" log dev-flow success --phase-durations '{"analyze":"x"}'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("phase_durations")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: --merge-tier-reasons with non-string element is dropped" {
    run "$SCRIPT" log dev-flow success --merge-tier-reasons '[{}]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("merge_tier_reasons")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "8 telemetry flags: unparseable JSON for --phase-durations is dropped without polluting stdout" {
    run "$SCRIPT" log dev-flow success --phase-durations '{broken'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    run jq empty "$entry_file"
    [ "$status" -eq 0 ]

    has_key=$(jq '.telemetry // {} | has("phase_durations")' "$entry_file")
    [ "$has_key" = "false" ]
}

# ---------------------------------------------------------------------------
# (e) drop の独立性: 1 キーの drop は他キー・base entry に影響しない
# ---------------------------------------------------------------------------
@test "8 telemetry flags: drop independence - route drop doesn't affect other telemetry" {
    run "$SCRIPT" log dev-flow success --route bogus --merge-tier REVIEW --duration-seconds 840
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_route=$(jq '.telemetry | has("route")' "$entry_file")
    [ "$has_route" = "false" ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]

    duration=$(jq '.telemetry.duration_seconds' "$entry_file")
    [ "$duration" = "840" ]
}

# ---------------------------------------------------------------------------
# (f) --testsurf-hits '[]' -> telemetry.testsurf_hits が [] で記録される（キー存在）
# ---------------------------------------------------------------------------
@test "8 telemetry flags: --testsurf-hits empty array is recorded (key present)" {
    run "$SCRIPT" log dev-flow success --testsurf-hits '[]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("testsurf_hits")' "$entry_file")
    [ "$has_key" = "true" ]

    val=$(jq -c '.telemetry.testsurf_hits' "$entry_file")
    [ "$val" = "[]" ]
}

# ---------------------------------------------------------------------------
# (g) --vdelta-fail-open 0 -> number 0 で記録される（キー存在）
# ---------------------------------------------------------------------------
@test "8 telemetry flags: --vdelta-fail-open 0 is recorded as number 0 (key present)" {
    run "$SCRIPT" log dev-flow success --vdelta-fail-open 0
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("vdelta_fail_open")' "$entry_file")
    [ "$has_key" = "true" ]

    val=$(jq '.telemetry.vdelta_fail_open' "$entry_file")
    [ "$val" = "0" ]
}

# ---------------------------------------------------------------------------
# (h) 8 フラグのうち --route lite のみ指定 -> route のみ存在し他 7 キーは欠落
# ---------------------------------------------------------------------------
@test "8 telemetry flags: only --route lite specified -> only route key present among the 8" {
    run "$SCRIPT" log dev-flow success --route lite
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    [ "$(jq -r '.telemetry.route' "$entry_file")" = "lite" ]

    for key in vdelta_verdicts vdelta_fail_open redgreen_deny testsurf_hits duration_seconds phase_durations merge_tier_reasons; do
        has_key=$(jq --arg k "$key" '.telemetry | has($k)' "$entry_file")
        [ "$has_key" = "false" ]
    done
}

# ---------------------------------------------------------------------------
# (i) 8 フラグ未指定・他 telemetry フラグも未指定 -> telemetry キー自体が無い
# ---------------------------------------------------------------------------
@test "8 telemetry flags: none specified and no other telemetry -> no telemetry key" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ---------------------------------------------------------------------------
# (j) 既存フラグ回帰: 8 新キーが混入しない
# ---------------------------------------------------------------------------
@test "8 telemetry flags: existing flags only -> new 8 keys don't leak in" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW --gate-policy llm-major-advisory
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]
    gate_policy=$(jq -r '.telemetry.gate_policy' "$entry_file")
    [ "$gate_policy" = "llm-major-advisory" ]

    for key in vdelta_verdicts vdelta_fail_open redgreen_deny testsurf_hits duration_seconds phase_durations merge_tier_reasons route; do
        has_key=$(jq --arg k "$key" '.telemetry | has($k)' "$entry_file")
        [ "$has_key" = "false" ]
    done
}

# ===========================================================================
# --guard-id flag (issue #530)
# ===========================================================================

# ---------------------------------------------------------------------------
# (d) 正常値 -> telemetry.guard_id が文字列として記録される
# ---------------------------------------------------------------------------
@test "--guard-id: valid value recorded as telemetry.guard_id string" {
    run "$SCRIPT" log dev-flow success --guard-id sandbox-deny
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    guard_id=$(jq -r '.telemetry.guard_id' "$entry_file")
    [ "$guard_id" = "sandbox-deny" ]
    guard_id_type=$(jq -r '.telemetry.guard_id | type' "$entry_file")
    [ "$guard_id_type" = "string" ]
}

# ---------------------------------------------------------------------------
# (e) 不正値（スペース混入）-> guard_id キーのみ drop、他 telemetry キーは無事
# ---------------------------------------------------------------------------
@test "--guard-id: value with spaces is dropped, other telemetry keys unaffected" {
    run "$SCRIPT" log dev-flow success --guard-id 'bad value with spaces' --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_guard_id=$(jq '.telemetry | has("guard_id")' "$entry_file")
    [ "$has_guard_id" = "false" ]
    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]
}

# ---------------------------------------------------------------------------
# (f) メタ文字混入 -> guard_id キーのみ drop、単独指定なら telemetry キー自体が無い
# ---------------------------------------------------------------------------
@test "--guard-id: shell metacharacters dropped, entry still recorded" {
    run "$SCRIPT" log dev-flow success --guard-id '$(rm -rf x)'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ---------------------------------------------------------------------------
# (g) 滞留 payload 同形状の統合ケース: guard_blocked + guard_id + merge_tier + route が共存
# ---------------------------------------------------------------------------
@test "--guard-id: coexists with --error-category guard_blocked and other telemetry flags" {
    run "$SCRIPT" log dev-flow success \
        --error-category guard_blocked \
        --guard-id sandbox-deny \
        --merge-tier HOLD \
        --route full
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    error_category=$(jq -r '.error.category' "$entry_file")
    [ "$error_category" = "guard_blocked" ]
    guard_id=$(jq -r '.telemetry.guard_id' "$entry_file")
    [ "$guard_id" = "sandbox-deny" ]
}

# ---------------------------------------------------------------------------
# (h) comma 結合値（複数 guard 発火時の送り側フォーマット） -> telemetry.guard_id にそのまま記録される
#     (issue #532: 送り側 dev-flow.js は guard_id を unique・sort して comma 結合した文字列を渡す)
# ---------------------------------------------------------------------------
@test "--guard-id: comma-joined multi-guard value recorded as telemetry.guard_id string" {
    run "$SCRIPT" log dev-flow success --guard-id 'inline-edit-guard,sandbox-deny'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    guard_id=$(jq -r '.telemetry.guard_id' "$entry_file")
    [ "$guard_id" = "inline-edit-guard,sandbox-deny" ]
    guard_id_type=$(jq -r '.telemetry.guard_id | type' "$entry_file")
    [ "$guard_id_type" = "string" ]
}

# ===========================================================================
# --subagent-invocations flag (issue #445)
# ===========================================================================

# ---------------------------------------------------------------------------
# (a) 正常値 -> telemetry.subagent_invocations が object で記録され total/by_type が一致
# ---------------------------------------------------------------------------
@test "--subagent-invocations: valid object recorded with total and by_type" {
    run "$SCRIPT" log dev-flow success \
        --subagent-invocations '{"total":59,"by_type":{"implementer":4,"dev-runner-haiku":16}}'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    [ "$(jq '.telemetry.subagent_invocations | type' "$entry_file")" = '"object"' ]
    [ "$(jq '.telemetry.subagent_invocations.total' "$entry_file")" = "59" ]
    [ "$(jq -c '.telemetry.subagent_invocations.by_type' "$entry_file")" = '{"implementer":4,"dev-runner-haiku":16}' ]
}

# ---------------------------------------------------------------------------
# (b) 不正値 -> exit 0・base entry 正常・telemetry.subagent_invocations キー無し
# ---------------------------------------------------------------------------
@test "--subagent-invocations: total as non-number is dropped" {
    run "$SCRIPT" log dev-flow success --subagent-invocations '{"total":"x"}'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    skill_val=$(jq -r '.skill' "$entry_file")
    [ "$skill_val" = "dev-flow" ]
    outcome_val=$(jq -r '.outcome' "$entry_file")
    [ "$outcome_val" = "success" ]

    has_key=$(jq '.telemetry // {} | has("subagent_invocations")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "--subagent-invocations: JSON array (non-object) is dropped" {
    run "$SCRIPT" log dev-flow success --subagent-invocations '[1]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry // {} | has("subagent_invocations")' "$entry_file")
    [ "$has_key" = "false" ]
}

@test "--subagent-invocations: unparseable JSON is dropped without polluting stdout" {
    run "$SCRIPT" log dev-flow success --subagent-invocations 'not-json'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    run jq empty "$entry_file"
    [ "$status" -eq 0 ]

    has_key=$(jq '.telemetry // {} | has("subagent_invocations")' "$entry_file")
    [ "$has_key" = "false" ]
}

# ---------------------------------------------------------------------------
# (c) フラグ未指定 -> telemetry にキー無し
# ---------------------------------------------------------------------------
@test "--subagent-invocations: not specified -> no telemetry key" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ===========================================================================
# --trust-evalseal-missing-reason (issue #471 AC-6)
# receipt 欠落理由の closed 6値 enum を journal telemetry へ到達させるフラグ
# ---------------------------------------------------------------------------

# (a) valid 値が telemetry.trust_evalseal_missing_reason へ到達する
@test "--trust-evalseal-missing-reason: valid value reaches telemetry" {
    run "$SCRIPT" log dev-flow success --trust-evalseal-missing-reason agent_throw
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    reason=$(jq -r '.telemetry.trust_evalseal_missing_reason' "$entry_file")
    [ "$reason" = "agent_throw" ]
}

# (a-2) enum の他の値も同様に通る
@test "--trust-evalseal-missing-reason: all 6 enum values are accepted" {
    for v in eval_skipped agent_throw agent_null seal_error mode_off unknown; do
        run "$SCRIPT" log dev-flow success --trust-evalseal-missing-reason "$v"
        [ "$status" -eq 0 ]

        entry_file=$(latest_entry)
        [ -n "$entry_file" ]

        reason=$(jq -r '.telemetry.trust_evalseal_missing_reason' "$entry_file")
        [ "$reason" = "$v" ]
    done
}

# (b) enum 外の値は exit 非0 + error JSON (die_json fail-closed)
@test "--trust-evalseal-missing-reason: out-of-enum value is rejected (die_json)" {
    run "$SCRIPT" log dev-flow success --trust-evalseal-missing-reason bogus
    [ "$status" -ne 0 ]

    error_status=$(echo "$output" | jq -r '.status')
    [ "$error_status" = "error" ]
}

# (b-2) 空文字も reject される
@test "--trust-evalseal-missing-reason: empty string is rejected" {
    run "$SCRIPT" log dev-flow success --trust-evalseal-missing-reason ""
    [ "$status" -ne 0 ]
}

# (c) フラグ未指定時は telemetry に当該キーが存在しない
@test "--trust-evalseal-missing-reason: not specified -> no telemetry key" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("trust_evalseal_missing_reason")' "$entry_file")
    [ "$has_key" = "false" ]
}

# ===========================================================================
# --trust-effectdelta-pr-missing-reason (issue #476 D-3)
# PR stage receipt 欠落理由の closed 8値 enum を journal telemetry へ到達させるフラグ
# (EvalSeal の trust_evalseal_missing_reason とは独立定義)
# ---------------------------------------------------------------------------

# (a) valid 値が telemetry.trust_effectdelta_pr_missing_reason へ到達する
@test "--trust-effectdelta-pr-missing-reason: valid value reaches telemetry" {
    run "$SCRIPT" log dev-flow success --trust-effectdelta-pr-missing-reason gh_failed
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    reason=$(jq -r '.telemetry.trust_effectdelta_pr_missing_reason' "$entry_file")
    [ "$reason" = "gh_failed" ]
}

# (a-2) enum の他の値も同様に通る
@test "--trust-effectdelta-pr-missing-reason: all 8 enum values are accepted" {
    for v in agent_throw agent_null mode_off gh_failed script_error agent_error schema_invalid unknown; do
        run "$SCRIPT" log dev-flow success --trust-effectdelta-pr-missing-reason "$v"
        [ "$status" -eq 0 ]

        entry_file=$(latest_entry)
        [ -n "$entry_file" ]

        reason=$(jq -r '.telemetry.trust_effectdelta_pr_missing_reason' "$entry_file")
        [ "$reason" = "$v" ]
    done
}

# (b) enum 外の値は exit 非0 + error JSON (die_json fail-closed)
@test "--trust-effectdelta-pr-missing-reason: out-of-enum value is rejected (die_json)" {
    run "$SCRIPT" log dev-flow success --trust-effectdelta-pr-missing-reason bogus
    [ "$status" -ne 0 ]

    error_status=$(echo "$output" | jq -r '.status')
    [ "$error_status" = "error" ]
}

# (b-2) 空文字も reject される
@test "--trust-effectdelta-pr-missing-reason: empty string is rejected" {
    run "$SCRIPT" log dev-flow success --trust-effectdelta-pr-missing-reason ""
    [ "$status" -ne 0 ]
}

# (c) フラグ未指定時は telemetry に当該キーが存在しない
@test "--trust-effectdelta-pr-missing-reason: not specified -> no telemetry key" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("trust_effectdelta_pr_missing_reason")' "$entry_file")
    [ "$has_key" = "false" ]
}

# ===========================================================================
# --eval-confidence / --review-confidence / --review-decision (issue #561)
# ===========================================================================

# (a) --eval-confidence 0.85 -> telemetry.eval_confidence は number 0.85
@test "--eval-confidence: valid number is recorded as telemetry.eval_confidence number" {
    run "$SCRIPT" log dev-flow success --eval-confidence 0.85
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    value=$(jq -r '.telemetry.eval_confidence' "$entry_file")
    type=$(jq -r '.telemetry.eval_confidence | type' "$entry_file")
    [ "$value" = "0.85" ]
    [ "$type" = "number" ]
}

# (b) --eval-confidence null -> telemetry.eval_confidence は JSON null（キーは存在する）
@test "--eval-confidence: literal null is recorded as telemetry.eval_confidence null (key present)" {
    run "$SCRIPT" log dev-flow success --eval-confidence null
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("eval_confidence")' "$entry_file")
    [ "$has_key" = "true" ]
    type=$(jq -r '.telemetry.eval_confidence | type' "$entry_file")
    [ "$type" = "null" ]
}

# (c) 範囲外の値 (1.5) は drop-and-warn: stderr に警告、entry は書かれ、telemetry にキーが無い
@test "--eval-confidence: out-of-range value is dropped with warning, entry still recorded" {
    run "$SCRIPT" log dev-flow success --eval-confidence 1.5
    [ "$status" -eq 0 ]
    [[ "$output" == *"dropping invalid --eval-confidence"* ]]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("eval_confidence")' "$entry_file")
    [ "$has_key" = "false" ]
}

# (d) 非数の値 (abc) は drop-and-warn
@test "--eval-confidence: non-numeric value is dropped with warning, entry still recorded" {
    run "$SCRIPT" log dev-flow success --eval-confidence abc
    [ "$status" -eq 0 ]
    [[ "$output" == *"dropping invalid --eval-confidence"* ]]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("eval_confidence")' "$entry_file")
    [ "$has_key" = "false" ]
}

# (e) 境界値 0 は正しく受理される (falsy 事故で落ちないこと)
@test "--eval-confidence: boundary value 0 is accepted (not dropped by falsy bug)" {
    run "$SCRIPT" log dev-flow success --eval-confidence 0
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("eval_confidence")' "$entry_file")
    [ "$has_key" = "true" ]
    value=$(jq -r '.telemetry.eval_confidence' "$entry_file")
    [ "$value" = "0" ]
}

# (e-2) 境界値 1 は正しく受理される
@test "--eval-confidence: boundary value 1 is accepted" {
    run "$SCRIPT" log dev-flow success --eval-confidence 1
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    value=$(jq -r '.telemetry.eval_confidence' "$entry_file")
    [ "$value" = "1" ]
}

# (f) フラグ未指定なら telemetry に eval_confidence キーが無い
@test "--eval-confidence: not specified -> no telemetry key" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("eval_confidence")' "$entry_file")
    [ "$has_key" = "false" ]
}

# (g) --review-confidence 0.6 と --review-decision approve が telemetry に記録される
@test "--review-confidence and --review-decision: valid values recorded" {
    run "$SCRIPT" log dev-flow success --review-confidence 0.6 --review-decision approve
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    review_confidence=$(jq -r '.telemetry.review_confidence' "$entry_file")
    review_decision=$(jq -r '.telemetry.review_decision' "$entry_file")
    [ "$review_confidence" = "0.6" ]
    [ "$review_decision" = "approve" ]
}

# (g-2) --review-confidence の範囲外・null も eval-confidence と同じ挙動をとる
@test "--review-confidence: literal null is recorded as null (key present)" {
    run "$SCRIPT" log dev-flow success --review-confidence null
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("review_confidence")' "$entry_file")
    [ "$has_key" = "true" ]
    type=$(jq -r '.telemetry.review_confidence | type' "$entry_file")
    [ "$type" = "null" ]
}

@test "--review-confidence: out-of-range value is dropped with warning" {
    run "$SCRIPT" log dev-flow success --review-confidence -0.1
    [ "$status" -eq 0 ]
    [[ "$output" == *"dropping invalid --review-confidence"* ]]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("review_confidence")' "$entry_file")
    [ "$has_key" = "false" ]
}

# (h) --review-decision が enum 外 (lgtm) の場合は drop-and-warn
@test "--review-decision: out-of-enum value is dropped with warning, entry still recorded" {
    run "$SCRIPT" log dev-flow success --review-decision lgtm
    [ "$status" -eq 0 ]
    [[ "$output" == *"dropping invalid --review-decision"* ]]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_key=$(jq '.telemetry | has("review_decision")' "$entry_file")
    [ "$has_key" = "false" ]
}

# (i) --review-decision の残り2つの enum 値 (request-changes / comment) も受理される
@test "--review-decision: request-changes and comment are accepted" {
    run "$SCRIPT" log dev-flow success --review-decision request-changes
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    value=$(jq -r '.telemetry.review_decision' "$entry_file")
    [ "$value" = "request-changes" ]

    run "$SCRIPT" log dev-flow success --review-decision comment
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    value=$(jq -r '.telemetry.review_decision' "$entry_file")
    [ "$value" = "comment" ]
}
