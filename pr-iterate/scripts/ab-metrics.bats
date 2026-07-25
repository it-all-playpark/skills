#!/usr/bin/env bats
# Tests for pr-iterate/scripts/ab-metrics.sh
#
# Strategy: write pinned-schema result-*.json fixtures (see F3) into a temp
# dir and assert the markdown output ab-metrics.sh renders on stdout, plus
# the warn/skip and exit-code behavior for malformed input.

bats_require_minimum_version 1.5.0

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/ab-metrics.sh"

    FIXTURE_DIR="$(mktemp -d "$BATS_TMPDIR/ab-metrics-fixtures.XXXXXX")"
}

teardown() {
    rm -rf "$FIXTURE_DIR"
}

# ---------------------------------------------------------------------------
# Test 1: detail row shows pr/mode/head_sha/blocking total/severity breakdown
# and blank token_usage when the optional key is absent.
# ---------------------------------------------------------------------------
@test "detail row shows pr/mode/blocking total/severity breakdown, blank token_usage" {
    cat > "$FIXTURE_DIR/result-101-single-1700000001.json" << 'EOF'
{
  "pr": 101,
  "mode": "single",
  "head_sha": "abcdef1234567890",
  "status": "lgtm",
  "iterations": 2,
  "fixes_applied": 1,
  "review_agent_calls_total": 3,
  "last_decision": "approve",
  "last_summary": "looks good",
  "history": [
    {
      "iteration": 1,
      "decision": "request-changes",
      "summary": "issues found",
      "blocking": [
        {"severity": "critical", "topic": "x"},
        {"severity": "major", "topic": "y"}
      ],
      "minor": [
        {"severity": "minor", "topic": "z"}
      ],
      "review_mode": "single",
      "review_agent_calls": 1
    },
    {
      "iteration": 2,
      "decision": "approve",
      "summary": "fixed",
      "blocking": [],
      "minor": [],
      "review_mode": "single",
      "review_agent_calls": 1
    }
  ]
}
EOF

    run "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"| 101 | single | abcdef1 | lgtm | 2 | approve | 2 | 1 | 1 | 1 | 3 | 1 |  |"* ]]
}

# ---------------------------------------------------------------------------
# Test 2: mode-level aggregation (run count, avg iterations, avg blocking,
# avg review_agent_calls_total) is computed correctly per mode.
# ---------------------------------------------------------------------------
@test "mode summary shows correct per-mode averages" {
    cat > "$FIXTURE_DIR/result-201-single-1700000010.json" << 'EOF'
{
  "pr": 201, "mode": "single", "head_sha": "1111111aaaa", "status": "lgtm",
  "iterations": 2, "fixes_applied": 0, "review_agent_calls_total": 2,
  "last_decision": "approve",
  "history": [
    {"iteration": 1, "decision": "approve",
     "blocking": [{"severity": "critical"}, {"severity": "major"}], "minor": []}
  ]
}
EOF
    cat > "$FIXTURE_DIR/result-202-single-1700000011.json" << 'EOF'
{
  "pr": 202, "mode": "single", "head_sha": "2222222bbbb", "status": "lgtm",
  "iterations": 4, "fixes_applied": 1, "review_agent_calls_total": 4,
  "last_decision": "approve",
  "history": [
    {"iteration": 1, "decision": "request-changes",
     "blocking": [{"severity": "critical"}, {"severity": "major"}], "minor": []},
    {"iteration": 2, "decision": "approve",
     "blocking": [{"severity": "critical"}, {"severity": "major"}], "minor": []}
  ]
}
EOF
    cat > "$FIXTURE_DIR/result-301-multi-1700000012.json" << 'EOF'
{
  "pr": 301, "mode": "multi", "head_sha": "3333333cccc", "status": "lgtm",
  "iterations": 1, "fixes_applied": 0, "review_agent_calls_total": 2,
  "last_decision": "approve",
  "history": [
    {"iteration": 1, "decision": "approve", "blocking": [], "minor": [],
     "review_mode": "multi", "review_agent_calls": 2}
  ]
}
EOF
    cat > "$FIXTURE_DIR/result-302-multi-1700000013.json" << 'EOF'
{
  "pr": 302, "mode": "multi", "head_sha": "4444444dddd", "status": "fix_failed",
  "iterations": 3, "fixes_applied": 2, "review_agent_calls_total": 6,
  "last_decision": "request-changes",
  "history": [
    {"iteration": 1, "decision": "request-changes",
     "blocking": [{"severity": "major"}], "minor": []},
    {"iteration": 2, "decision": "request-changes",
     "blocking": [{"severity": "critical"}], "minor": []},
    {"iteration": 3, "decision": "request-changes", "blocking": [], "minor": []}
  ]
}
EOF

    run "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"| single | 2 | 3 | 3 | 3 |"* ]]
    [[ "$output" == *"| multi | 2 | 2 | 1 | 4 |"* ]]
}

# ---------------------------------------------------------------------------
# Test 3: malformed JSON is warned about on stderr and skipped, while valid
# files still get processed; overall exit code stays 0.
# ---------------------------------------------------------------------------
@test "broken JSON warns to stderr and is skipped, exit 0" {
    cat > "$FIXTURE_DIR/result-401-single-1700000020.json" << 'EOF'
{
  "pr": 401, "mode": "single", "head_sha": "5555555eeee", "status": "lgtm",
  "iterations": 1, "fixes_applied": 0, "review_agent_calls_total": 1,
  "last_decision": "approve",
  "history": [{"iteration": 1, "decision": "approve", "blocking": [], "minor": []}]
}
EOF
    printf '{ this is not valid json' > "$FIXTURE_DIR/result-999-broken-1700000021.json"

    run --separate-stderr "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 0 ]
    [[ "$stderr" == *"result-999-broken-1700000021.json"* ]]
    [[ "$output" == *"| 401 | single |"* ]]
}

# ---------------------------------------------------------------------------
# Test 3b: valid JSON but missing a required pinned-schema key is warned
# about on stderr and skipped, exit 0.
# ---------------------------------------------------------------------------
@test "JSON missing required key warns to stderr and is skipped, exit 0" {
    printf '{"pr": 402, "mode": "single", "status": "lgtm"}\n' \
        > "$FIXTURE_DIR/result-402-single-1700000022.json"

    run --separate-stderr "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 0 ]
    [[ "$stderr" == *"result-402-single-1700000022.json"* ]]
    [[ "$output" != *"| 402 |"* ]]
}

# ---------------------------------------------------------------------------
# Test 4: empty (or non-existent) dir -> 'no ab-run results found' on
# stderr, exit 0.
# ---------------------------------------------------------------------------
@test "empty dir -> 'no ab-run results found' on stderr, exit 0" {
    run --separate-stderr "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 0 ]
    [[ "$stderr" == *"no ab-run results found"* ]]
}

@test "non-existent dir -> 'no ab-run results found' on stderr, exit 0" {
    run --separate-stderr "$SCRIPT" "$FIXTURE_DIR/does-not-exist"
    [ "$status" -eq 0 ]
    [[ "$stderr" == *"no ab-run results found"* ]]
}

# ---------------------------------------------------------------------------
# Test 5: token_usage present renders as input/output pair.
# ---------------------------------------------------------------------------
@test "token_usage present renders input/output pair" {
    cat > "$FIXTURE_DIR/result-501-single-1700000030.json" << 'EOF'
{
  "pr": 501, "mode": "single", "head_sha": "6666666ffff", "status": "lgtm",
  "iterations": 1, "fixes_applied": 0, "review_agent_calls_total": 1,
  "last_decision": "approve",
  "history": [{"iteration": 1, "decision": "approve", "blocking": [], "minor": []}],
  "token_usage": {"input": 12345, "output": 6789}
}
EOF

    run "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"| 12345/6789 |"* ]]
}

# ---------------------------------------------------------------------------
# Test 6: jq not installed -> exit 1 with an error message.
# ---------------------------------------------------------------------------
@test "jq not installed -> exit 1" {
    STUB_DIR="$BATS_TMPDIR/ab-metrics-no-jq-bin"
    mkdir -p "$STUB_DIR"
    for bin in bash sh; do
        real="$(command -v "$bin")"
        [ -n "$real" ] && ln -sf "$real" "$STUB_DIR/$bin"
    done

    run env PATH="$STUB_DIR" "$SCRIPT" "$FIXTURE_DIR"
    [ "$status" -eq 1 ]
    [[ "$output" == *"jq"* ]]
}
