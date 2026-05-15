#!/usr/bin/env bats
# Tests for _lib/scripts/auto-merge-guard.sh

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_lib/scripts/auto-merge-guard.sh"
}

@test "integration/issue-* is allowed" {
    run "$SCRIPT" --base "integration/issue-93-foo"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "allowed"'* ]]
    [[ "$output" == *'"matched_pattern": "integration/issue-*"'* ]]
}

@test "nightly/* is allowed" {
    run "$SCRIPT" --base "nightly/2026-05-15"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status": "allowed"'* ]]
}

@test "main is refused" {
    run "$SCRIPT" --base "main"
    [ "$status" -eq 1 ]
    [[ "$output" == *'"status": "refused"'* ]]
}

@test "dev is refused" {
    run "$SCRIPT" --base "dev"
    [ "$status" -eq 1 ]
    [[ "$output" == *'"status": "refused"'* ]]
}

@test "arbitrary feature branch is refused" {
    run "$SCRIPT" --base "feature/issue-99-x"
    [ "$status" -eq 1 ]
    [[ "$output" == *'"status": "refused"'* ]]
}

@test "missing args returns 2" {
    run "$SCRIPT"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Either --pr or --base"* ]]
}

@test "unknown option returns 2" {
    run "$SCRIPT" --bogus value
    [ "$status" -eq 2 ]
    [[ "$output" == *"Unknown option"* ]]
}

@test "custom skill-config allow list overrides defaults" {
    TMP="$BATS_TMPDIR/skill-config.json"
    cat > "$TMP" << 'EOF'
{ "auto_merge": { "allowed_base_patterns": ["staging/*"] } }
EOF
    SKILL_CONFIG_PATH="$TMP" run "$SCRIPT" --base "staging/2026-05"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"matched_pattern": "staging/*"'* ]]
    SKILL_CONFIG_PATH="$TMP" run "$SCRIPT" --base "integration/issue-1"
    [ "$status" -eq 1 ]
}

@test "pattern with whitespace is rejected with exit 2" {
    TMP="$BATS_TMPDIR/skill-config-bad.json"
    cat > "$TMP" << 'EOF'
{ "auto_merge": { "allowed_base_patterns": ["integration/with space*"] } }
EOF
    SKILL_CONFIG_PATH="$TMP" run "$SCRIPT" --base "main"
    [ "$status" -eq 2 ]
    [[ "$output" == *"contains whitespace"* ]]
}

@test "empty pattern is rejected with exit 2" {
    TMP="$BATS_TMPDIR/skill-config-empty.json"
    cat > "$TMP" << 'EOF'
{ "auto_merge": { "allowed_base_patterns": [""] } }
EOF
    SKILL_CONFIG_PATH="$TMP" run "$SCRIPT" --base "main"
    [ "$status" -eq 2 ]
    [[ "$output" == *"empty pattern"* ]]
}
