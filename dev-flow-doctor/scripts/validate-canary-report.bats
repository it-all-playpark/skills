#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/validate-canary-report.sh
#
# canary report スキーマ (canary_version "1.0.0") の決定論 validate:
# - required keys (canary_version / claude_code_version / capabilities / bridge_sunset)
# - canary_version は "1.0.0" const 固定（後方互換 fallback なし）
# - capabilities の id 集合は 9 個ちょうど（過不足・未知 id は schema violation）
# - capability.status / bridge_sunset.verdict の enum チェック
# を検証し、valid なら summary JSON（counts/failed_ids/unsupported_ids/bridge_sunset）を
# stdout + exit 0、invalid なら {"ok":false,"error":...} を stdout + exit 2 で返す。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/validate-canary-report.sh"

# 9 capability id 全部を "pass" で埋めた valid report を $1 に書き出す。
write_valid_report() {
    local out="$1"
    cat > "$out" <<'EOF'
{
  "canary_version": "1.0.0",
  "claude_code_version": "2.1.80",
  "timestamp_utc": "2026-07-13T00:00:00Z",
  "capabilities": [
    {"id": "agent_schema", "status": "pass", "detail": "ok"},
    {"id": "model_routing", "status": "pass", "detail": "ok"},
    {"id": "effort_routing", "status": "pass", "detail": "ok"},
    {"id": "parallel_fanout", "status": "pass", "detail": "ok"},
    {"id": "nested_workflow", "status": "pass", "detail": "ok"},
    {"id": "pause_resume", "status": "pass", "detail": "ok"},
    {"id": "direct_fs", "status": "pass", "detail": "ok"},
    {"id": "direct_shell", "status": "pass", "detail": "ok"},
    {"id": "direct_import", "status": "pass", "detail": "ok"}
  ],
  "bridge_sunset": {
    "exec_proxy_removable": false,
    "inline_generator_removable": false,
    "verdict": "keep-bridges",
    "note": "bridges kept"
  },
  "report_path": "/tmp/report.json"
}
EOF
}

@test "(1) 9 capability 全部 pass の valid fixture: exit 0 + ok:true + counts 正確" {
    REPORT="$BATS_TEST_TMPDIR/valid.json"
    write_valid_report "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true' >/dev/null
    echo "$output" | jq -e '.canary_version == "1.0.0"' >/dev/null
    echo "$output" | jq -e '.claude_code_version == "2.1.80"' >/dev/null
    echo "$output" | jq -e '.counts.pass == 9 and .counts.fail == 0 and .counts.unsupported == 0' >/dev/null
    echo "$output" | jq -e '.failed_ids == [] and .unsupported_ids == []' >/dev/null
    echo "$output" | jq -e '.bridge_sunset.verdict == "keep-bridges"' >/dev/null
}

@test "(2) capabilities に 1 id 欠落: exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/missing-id.json"
    write_valid_report "$REPORT"
    jq '.capabilities |= map(select(.id != "model_routing"))' "$REPORT" > "$REPORT.tmp"
    mv "$REPORT.tmp" "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(3) status が 'passed' (enum 外): exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/bad-status.json"
    write_valid_report "$REPORT"
    jq '.capabilities[0].status = "passed"' "$REPORT" > "$REPORT.tmp"
    mv "$REPORT.tmp" "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(4) 未知 capability id 追加: exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/extra-id.json"
    write_valid_report "$REPORT"
    jq '.capabilities += [{"id": "unknown_capability", "status": "pass", "detail": "?"}]' "$REPORT" > "$REPORT.tmp"
    mv "$REPORT.tmp" "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(5) canary_version '0.9.0' (const 不一致): exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/bad-version.json"
    write_valid_report "$REPORT"
    jq '.canary_version = "0.9.0"' "$REPORT" > "$REPORT.tmp"
    mv "$REPORT.tmp" "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(6) 非 JSON ファイル: exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/not-json.txt"
    printf 'this is not json\n' > "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(7) ファイル不在: exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/does-not-exist.json"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(8) bridge_sunset.verdict が enum 外: exit 2 + ok:false" {
    REPORT="$BATS_TEST_TMPDIR/bad-verdict.json"
    write_valid_report "$REPORT"
    jq '.bridge_sunset.verdict = "unknown-verdict"' "$REPORT" > "$REPORT.tmp"
    mv "$REPORT.tmp" "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(9) fail/unsupported 混在 fixture: counts と failed_ids/unsupported_ids が正確" {
    REPORT="$BATS_TEST_TMPDIR/mixed.json"
    write_valid_report "$REPORT"
    jq '
      .capabilities[0].status = "fail" |
      .capabilities[1].status = "fail" |
      .capabilities[2].status = "unsupported"
    ' "$REPORT" > "$REPORT.tmp"
    mv "$REPORT.tmp" "$REPORT"

    run "$SCRIPT" "$REPORT"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true' >/dev/null
    echo "$output" | jq -e '.counts.pass == 6 and .counts.fail == 2 and .counts.unsupported == 1' >/dev/null
    echo "$output" | jq -e '(.failed_ids | sort) == ["agent_schema","model_routing"]' >/dev/null
    echo "$output" | jq -e '(.unsupported_ids | sort) == ["effort_routing"]' >/dev/null
}

@test "(10) 引数なし: exit 2 + ok:false" {
    run "$SCRIPT"

    [ "$status" -eq 2 ]
}
