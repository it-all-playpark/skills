#!/usr/bin/env bats
# Tests for journal/scripts/journal.sh
# Focus: prune（保持期間による削除）と、query の --since 事前絞り込み・壊れたファイルの扱い。

bats_require_minimum_version 1.5.0

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/journal/scripts/journal.sh"

    export CLAUDE_JOURNAL_DIR="$BATS_TEST_TMPDIR/journal"
    mkdir -p "$CLAUDE_JOURNAL_DIR"

    OLD_DATE="2000-01-01"
    TODAY=$(date -u +%Y-%m-%d)
}

# Helper: write an entry file named like cmd_log does (<UTC date>-<time>-<label>-<pid>.json)
write_entry() {
    local date="$1" skill="$2" label="${3:-$2}"
    jq -n --arg skill "$skill" --arg ts "${date}T00:00:00Z" \
        '{id: "x", timestamp: $ts, skill: $skill, outcome: "success", source: "skill"}' \
        > "$CLAUDE_JOURNAL_DIR/${date}-00-00-00-${label}-1.json"
}

@test "prune deletes old entries of non-dev-flow skills only" {
    write_entry "$OLD_DATE" blog-publish
    write_entry "$OLD_DATE" hook-Bash
    write_entry "$OLD_DATE" dev-flow
    write_entry "$OLD_DATE" pr-iterate
    write_entry "$TODAY" blog-publish

    run "$SCRIPT" prune --days 30
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.pruned')" = "2" ]
    [ "$(echo "$output" | jq -r '.kept')" = "2" ]

    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ]
    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-hook-Bash-1.json" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-dev-flow-1.json" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-pr-iterate-1.json" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${TODAY}-00-00-00-blog-publish-1.json" ]
}

@test "prune deletes old entries of the removed doctor / improve skills" {
    write_entry "$OLD_DATE" dev-flow-doctor
    write_entry "$OLD_DATE" dev-flow-improve
    write_entry "$OLD_DATE" dev-improve
    write_entry "$OLD_DATE" dev-flow

    run "$SCRIPT" prune --days 30
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.pruned')" = "3" ]

    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-dev-flow-doctor-1.json" ]
    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-dev-flow-improve-1.json" ]
    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-dev-improve-1.json" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-dev-flow-1.json" ]
}

@test "prune --dry-run reports but deletes nothing" {
    write_entry "$OLD_DATE" blog-publish

    run "$SCRIPT" prune --days 30 --dry-run
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "dry-run" ]
    [ "$(echo "$output" | jq -r '.pruned')" = "1" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ]
}

@test "prune keeps undated names and corrupt files it cannot classify" {
    echo '{"skill":"blog-publish"}' > "$CLAUDE_JOURNAL_DIR/legacy-entry.json"
    echo '{not valid json' > "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-broken-1.json"
    write_entry "$OLD_DATE" blog-publish

    run "$SCRIPT" prune --days 30
    [ "$status" -eq 0 ]
    [ -f "$CLAUDE_JOURNAL_DIR/legacy-entry.json" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-broken-1.json" ]
    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ]
}

@test "prune --keep overrides the default keep list" {
    write_entry "$OLD_DATE" dev-flow
    write_entry "$OLD_DATE" blog-publish

    run "$SCRIPT" prune --days 30 --keep blog-publish
    [ "$status" -eq 0 ]
    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-dev-flow-1.json" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ]
}

@test "prune rejects a non-positive --days" {
    run "$SCRIPT" prune --days 0
    [ "$status" -ne 0 ]
}

@test "query --since skips files dated before the window" {
    write_entry "$OLD_DATE" dev-flow
    write_entry "$TODAY" dev-flow

    run "$SCRIPT" query --since 7d --skill dev-flow
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq 'length')" = "1" ]
}

@test "query skips a corrupt file with a warning and still returns valid entries" {
    write_entry "$TODAY" dev-flow
    echo '{not valid json' > "$CLAUDE_JOURNAL_DIR/${TODAY}-00-00-01-broken-1.json"

    run --separate-stderr "$SCRIPT" query --skill dev-flow
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq 'length')" = "1" ]
    [[ "$stderr" == *"skipping corrupt file"* ]]
}

# session_id を空にして /tmp の状態ファイルを書かせない（sandbox では /tmp 直下に書けない）。
# 自動 prune は状態ファイルより前に走るので、これで prune 部分だけを確かめられる。
track_skill_no_session() {
    echo '{"tool_input":{"skill":"x"},"session_id":""}' | "$SCRIPT" track-skill
}

@test "track-skill auto-prunes in the background at most once a day" {
    write_entry "$OLD_DATE" blog-publish

    run track_skill_no_session
    [ "$status" -eq 0 ]
    [ -f "$CLAUDE_JOURNAL_DIR/.last-prune" ]

    for _ in $(seq 1 50); do
        [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ] || break
        sleep 0.1
    done
    [ ! -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ]

    # 同じ日のうちは stamp があるので再実行しない
    write_entry "$OLD_DATE" hook-Bash
    run track_skill_no_session
    [ "$status" -eq 0 ]
    sleep 0.5
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-hook-Bash-1.json" ]
}

@test "track-skill does not auto-prune when JOURNAL_PRUNE_DAYS=0" {
    write_entry "$OLD_DATE" blog-publish

    JOURNAL_PRUNE_DAYS=0 run track_skill_no_session
    [ "$status" -eq 0 ]
    sleep 0.5
    [ ! -f "$CLAUDE_JOURNAL_DIR/.last-prune" ]
    [ -f "$CLAUDE_JOURNAL_DIR/${OLD_DATE}-00-00-00-blog-publish-1.json" ]
}
