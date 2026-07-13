#!/usr/bin/env bats
# Tests for dev-flow-improve/scripts/hypothesis-check.sh

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow-improve/scripts/hypothesis-check.sh"
    export CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
}

# $1=filename $2=timestamp $3=iterate_status $4=shape $5=eval_iter(省略時1)
write_entry() {
    jq -n --arg ts "$2" --arg it "$3" --arg sh "$4" --argjson ei "${5:-1}" \
        '{version:"1.0.0", timestamp:$ts, skill:"dev-flow", outcome:"success",
          telemetry:{iterate_status:$it, shape:$sh, eval_iter:$ei, plan_iter:1}}' \
        > "$CLAUDE_JOURNAL_DIR/$1"
}

@test "iterate_unhealthy_rate: 半数 unhealthy → value 0.5、lte 0.5 で confirmed" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm standard
    write_entry b.json 2026-07-02T00:00:00Z stuck standard
    run bash "$SCRIPT" --metric iterate_unhealthy_rate --since 2026-06-30T00:00:00Z --target 0.5 --min-runs 2
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.value')" = "0.5" ]
    [ "$(echo "$output" | jq -r '.runs')" = "2" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "confirmed" ]
}

@test "since フィルタ: 窓外 entry は分母に入らない" {
    write_entry old.json 2026-01-01T00:00:00Z stuck standard
    write_entry new.json 2026-07-02T00:00:00Z lgtm standard
    run bash "$SCRIPT" --metric iterate_unhealthy_rate --since 2026-06-30T00:00:00Z --target 0.1 --min-runs 1
    [ "$(echo "$output" | jq -r '.runs')" = "1" ]
    [ "$(echo "$output" | jq -r '.value')" = "0" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "confirmed" ]
}

@test "min-runs 未達 → insufficient_data" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm standard
    run bash "$SCRIPT" --metric iterate_unhealthy_rate --since 2026-06-30T00:00:00Z --target 0.5 --min-runs 5
    [ "$(echo "$output" | jq -r '.verdict')" = "insufficient_data" ]
}

@test "micro_share: gte direction（target 以上で confirmed）" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm micro
    write_entry b.json 2026-07-02T00:00:00Z lgtm standard
    run bash "$SCRIPT" --metric micro_share --since 2026-06-30T00:00:00Z --target 0.3 --min-runs 2
    [ "$(echo "$output" | jq -r '.value')" = "0.5" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "confirmed" ]
}

@test "cap_pinned_count: eval_iter>=10 を数え、lte 0 で not_confirmed" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm standard 10
    write_entry b.json 2026-07-02T00:00:00Z lgtm standard 2
    run bash "$SCRIPT" --metric cap_pinned_count --since 2026-06-30T00:00:00Z --target 0 --min-runs 2
    [ "$(echo "$output" | jq -r '.value')" = "1" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "not_confirmed" ]
}

@test "out-of-enum metric は error exit" {
    run bash "$SCRIPT" --metric bogus_metric --since 2026-06-30T00:00:00Z --target 0 --min-runs 1
    [ "$status" -ne 0 ]
}

@test "引数不足 / 不正 --since は error exit" {
    run bash "$SCRIPT" --metric micro_share --target 0.3 --min-runs 1
    [ "$status" -ne 0 ]
    run bash "$SCRIPT" --metric micro_share --since not-a-date --target 0.3 --min-runs 1
    [ "$status" -ne 0 ]
}
