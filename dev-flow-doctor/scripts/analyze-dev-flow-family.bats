#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/analyze-dev-flow-family.sh
#
# Focus: ARG_MAX-safe load_journal_entries — verifies that a large corpus
# (8,000 files with long path names) succeeds where the old
# `jq -s '.' "${files[@]}"` fast-path would hit "Argument list too long".
#
# Test cases:
#   1. ARG_MAX regression: 8,000 journal files → status 0, valid JSON,
#      dev-kickoff total == 8000
#   2. malformed-file tolerance: 3 valid + 1 broken → exit 0, valid 3 counted
#   3. empty journal dir → exit 0, per_skill all-zero totals
#   4. non-existent CLAUDE_JOURNAL_DIR → exit 0

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/analyze-dev-flow-family.sh"

# ---------------------------------------------------------------------------
# setup_file: create the large corpus once for the entire test file.
#   We generate 8,000 journal JSON files with basenames padded to ~240 chars
#   so that the aggregate argv length exceeds macOS ARG_MAX (1 MB) when all
#   paths are expanded into a single execve call.
# ---------------------------------------------------------------------------
setup_file() {
    export CORPUS_DIR
    CORPUS_DIR="$(mktemp -d)"

    # Empty config so environment skill-config.json does not leak in
    export EMPTY_CONFIG
    EMPTY_CONFIG="$(mktemp)"
    printf '{}' > "$EMPTY_CONFIG"

    # Today's date in UTC for the timestamp field
    TODAY_ISO="$(date -u +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u --iso-8601=seconds | sed 's/+.*/Z/')"

    # Generate 8,000 files.
    # Basename padding: "aaa...a-N.json" where the 'a' run is 220 chars,
    # giving each basename ~231 chars.
    # With a typical /tmp/... prefix (~30 chars) each full path is ~260 chars.
    # 8000 x 260 = ~2 MB >> macOS ARG_MAX = 1 MB.
    local pad
    pad="$(printf 'a%.0s' {1..220})"
    local i
    for i in $(seq 1 8000); do
        local fname="${pad}-${i}.json"
        printf '{"id":"t-%d","timestamp":"%s","skill":"dev-kickoff","outcome":"success","source":"skill","duration_turns":3}\n' \
            "$i" "$TODAY_ISO" > "${CORPUS_DIR}/${fname}"
    done
}

teardown_file() {
    rm -rf "$CORPUS_DIR"
    rm -f "$EMPTY_CONFIG"
}

# ---------------------------------------------------------------------------
# setup / teardown per test: small journals live in BATS_TMPDIR
# ---------------------------------------------------------------------------
setup() {
    EMPTY_CONFIG_LOCAL="$(mktemp)"
    printf '{}' > "$EMPTY_CONFIG_LOCAL"
}

teardown() {
    rm -f "$EMPTY_CONFIG_LOCAL"
}

# ---------------------------------------------------------------------------
# Test 1: ARG_MAX regression
#   8,000 files whose paths exceed ARG_MAX in aggregate.
#   Old fast-path: `jq -s '.' "${files[@]}"` -> "Argument list too long".
#   New fast-path: printf NUL-pipe + xargs -0 cat + jq -s stdin -> succeeds.
# ---------------------------------------------------------------------------
@test "ARG_MAX regression: 8000 large-path files -> exit 0, valid JSON, total==8000" {
    run env \
        CLAUDE_JOURNAL_DIR="$CORPUS_DIR" \
        SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
        bash "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    # Output must be valid JSON
    printf '%s\n' "$output" | jq empty

    # dev-kickoff must have total == 8000
    local total
    total=$(printf '%s\n' "$output" | jq '[.per_skill[] | select(.skill=="dev-kickoff")][0].total')
    [ "$total" -eq 8000 ]
}

# ---------------------------------------------------------------------------
# Test 2: malformed-file tolerance
#   3 valid + 1 broken JSON file -> exit 0, valid 3 entries counted.
# ---------------------------------------------------------------------------
@test "malformed-file tolerance: 3 valid + 1 broken -> exit 0, dev-kickoff total==3" {
    local jdir
    jdir="$(mktemp -d)"
    local today_iso
    today_iso="$(date -u +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u --iso-8601=seconds | sed 's/+.*/Z/')"

    # 3 valid entries
    local i
    for i in 1 2 3; do
        printf '{"id":"m-%d","timestamp":"%s","skill":"dev-kickoff","outcome":"success","source":"skill","duration_turns":2}\n' \
            "$i" "$today_iso" > "${jdir}/valid-${i}.json"
    done
    # 1 broken entry (truncated JSON)
    printf '{"broken":' > "${jdir}/broken.json"

    run env \
        CLAUDE_JOURNAL_DIR="$jdir" \
        SKILL_CONFIG_PATH="$EMPTY_CONFIG_LOCAL" \
        bash "$SCRIPT" --window 30d
    rm -rf "$jdir"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    local total
    total=$(printf '%s\n' "$output" | jq '[.per_skill[] | select(.skill=="dev-kickoff")][0].total')
    [ "$total" -eq 3 ]
}

# ---------------------------------------------------------------------------
# Test 3: empty journal dir -> exit 0, all per_skill totals == 0
# ---------------------------------------------------------------------------
@test "empty journal dir -> exit 0, all per_skill totals == 0" {
    local jdir
    jdir="$(mktemp -d)"

    run env \
        CLAUDE_JOURNAL_DIR="$jdir" \
        SKILL_CONFIG_PATH="$EMPTY_CONFIG_LOCAL" \
        bash "$SCRIPT" --window 30d
    rm -rf "$jdir"
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty

    local sum
    sum=$(printf '%s\n' "$output" | jq '[.per_skill[].total] | add // 0')
    [ "$sum" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test 4: non-existent CLAUDE_JOURNAL_DIR -> exit 0
# ---------------------------------------------------------------------------
@test "non-existent CLAUDE_JOURNAL_DIR -> exit 0" {
    run env \
        CLAUDE_JOURNAL_DIR="/nonexistent/path/that/does/not/exist" \
        SKILL_CONFIG_PATH="$EMPTY_CONFIG_LOCAL" \
        bash "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    printf '%s\n' "$output" | jq empty
}
