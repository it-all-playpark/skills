#!/usr/bin/env bats
# Tests for analyze-dev-flow-family.sh
# Focus: hook source exclusion from family entries and parent_refs "hook" matching.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow-doctor/scripts/analyze-dev-flow-family.sh"

    # Isolate journal to a temp directory for each test
    export CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$"
    mkdir -p "$CLAUDE_JOURNAL_DIR"

    # Use a minimal skill-config so config resolution doesn't leak in
    export SKILL_CONFIG_PATH="$BATS_TMPDIR/cfg-$$.json"
    echo '{}' > "$SKILL_CONFIG_PATH"

    # Generate a relative timestamp (1 day ago) so fixtures are always within a 30d window.
    # macOS uses -v flag; GNU date uses -d flag.
    TS=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
    rm -f "$SKILL_CONFIG_PATH"
}

# ---------------------------------------------------------------------------
# Test (a): source="hook" entry is excluded from per_skill total
# ---------------------------------------------------------------------------
@test "(a) skill=dev-kickoff source=hook outcome=failure is excluded from per_skill total" {
    cat > "$CLAUDE_JOURNAL_DIR/hook-entry.json" <<EOF
{
  "version": "1.0.0",
  "id": "hook-entry-1",
  "timestamp": "$TS",
  "skill": "dev-kickoff",
  "source": "hook",
  "outcome": "failure",
  "duration_turns": 0,
  "context": {}
}
EOF

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    # The hook entry must not be counted in per_skill for dev-kickoff
    total=$(echo "$output" | jq '[.per_skill[] | select(.skill == "dev-kickoff")] | .[0].total // 0')
    [ "$total" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test (b): entry without source key is treated as skill (included in total)
# ---------------------------------------------------------------------------
@test "(b) skill=dev-kickoff with no source key is included in per_skill total" {
    cat > "$CLAUDE_JOURNAL_DIR/skill-entry-no-source.json" <<EOF
{
  "version": "1.0.0",
  "id": "skill-entry-nosrc-1",
  "timestamp": "$TS",
  "skill": "dev-kickoff",
  "outcome": "success",
  "duration_turns": 5,
  "context": {}
}
EOF

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    # Entry without source must be counted (backward-compatible: skill assumed)
    total=$(echo "$output" | jq '[.per_skill[] | select(.skill == "dev-kickoff")] | .[0].total')
    [ "$total" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (c): source="hook" entry whose context.input_summary references dev-implement
#           prevents dev-implement from appearing in disconnected_skills
# ---------------------------------------------------------------------------
@test "(c) source=hook entry referencing dev-implement keeps it out of disconnected_skills" {
    # Hook entry that references dev-implement in input_summary.
    # source is "hook" (new value). dev-implement has zero own entries.
    cat > "$CLAUDE_JOURNAL_DIR/hook-ref-entry.json" <<EOF
{
  "version": "1.0.0",
  "id": "hook-ref-1",
  "timestamp": "$TS",
  "skill": "hook-capture",
  "source": "hook",
  "outcome": "success",
  "duration_turns": 0,
  "context": {
    "input_summary": "Skill: dev-implement --issue 42"
  }
}
EOF

    run "$SCRIPT" --window 30d
    [ "$status" -eq 0 ]

    # dev-implement has no own entries but IS referenced via source="hook" entry
    # -> should NOT appear in disconnected_skills
    disc_count=$(echo "$output" | jq '[.findings.disconnected_skills[] | select(.skill == "dev-implement")] | length')
    [ "$disc_count" -eq 0 ]
}
