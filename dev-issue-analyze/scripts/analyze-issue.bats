#!/usr/bin/env bats
# Tests for dev-issue-analyze/scripts/analyze-issue.sh
#
# Strategy: shim out `gh` with a stub that answers `gh auth token` (for
# common.sh's require_gh_auth) and `gh issue view <n> --json ...` by cat-ing
# a fixture JSON file pointed to by $GH_FIXTURE.
#
# Covers: breaking_keyword_scan determinism across all depths (minimal /
# standard / comprehensive), full-body scan beyond the 500-char body_preview
# boundary, Japanese keyword detection, and a >64KB body regression to pin
# the here-string (non-pipe) SIGPIPE-safe implementation.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-issue-analyze/scripts/analyze-issue.sh"

    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/gh" << 'EOF'
#!/usr/bin/env bash
case "$1" in
    auth)
        echo "dummy-token"
        exit 0
        ;;
    issue)
        cat "$GH_FIXTURE"
        ;;
    *)
        exit 1
        ;;
esac
EOF
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"

    FIXTURE_DIR="$BATS_TMPDIR/fixtures"
    mkdir -p "$FIXTURE_DIR"
}

make_fixture() {
    # make_fixture <path> <title> <body>
    local path="$1" title="$2" body="$3"
    jq -n --arg title "$title" --arg body "$body" \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null}' \
        > "$path"
}

# Placeholder AC/requirement bullet lines prepended to bodies used at
# --depth standard|comprehensive. These are NOT part of the breaking-keyword
# scan under test; they exist only so extract_ac / extract_requirements
# always have >=1 match (a pre-existing, out-of-scope pipefail edge case in
# analyze-issue.sh causes the whole script to exit non-zero when a body has
# zero AC/requirement bullet matches). Keeping fixtures self-contained here
# avoids widening this task's blast radius into that unrelated bug.
AC_STUB="- [ ] Placeholder AC item"$'\n'"- Placeholder Requirement Item"$'\n\n'
# Same rationale, additionally covering --depth comprehensive's
# affected_files / components extraction (also zero-match-sensitive).
COMPREHENSIVE_STUB="${AC_STUB}See src/example.ts and FooComponent for details."$'\n\n'

# ---------------------------------------------------------------------------
# (a) clean issue + --depth minimal -> breaking_keyword_scan:false present
# ---------------------------------------------------------------------------
@test "minimal depth: clean issue -> breaking_keyword_scan:false present" {
    FIXTURE="$FIXTURE_DIR/clean.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak, nothing else."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 1 --depth minimal
    [ "$status" -eq 0 ]
    [[ "$output" == *'"breaking_keyword_scan":false'* ]]
    echo "$output" | jq -e '.breaking_keyword_scan == false'
}

# ---------------------------------------------------------------------------
# (b) title has breaking keyword, body clean + --depth minimal -> true
# ---------------------------------------------------------------------------
@test "minimal depth: breaking keyword in title -> breaking_keyword_scan:true" {
    FIXTURE="$FIXTURE_DIR/breaking-title.json"
    make_fixture "$FIXTURE" "Breaking: rename API" "Just a UI tweak, nothing else."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 2 --depth minimal
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (c) keyword appears after the 500-char body_preview boundary + --depth standard -> true
# ---------------------------------------------------------------------------
@test "standard depth: keyword beyond 500-char body_preview boundary -> true (full-body scan)" {
    PAD="$(printf '%*s' 600 '')"
    PAD="${PAD// /x}"
    BODY="${AC_STUB}${PAD} migration required for downstream consumers."
    FIXTURE="$FIXTURE_DIR/boundary.json"
    make_fixture "$FIXTURE" "Refactor internals" "$BODY"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 3 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (d) Japanese keyword 破壊的変更 + --depth standard -> true
# ---------------------------------------------------------------------------
@test "standard depth: Japanese keyword 破壊的変更 -> true" {
    FIXTURE="$FIXTURE_DIR/ja.json"
    make_fixture "$FIXTURE" "スキーマ更新" "${AC_STUB}この変更には破壊的変更が含まれます。"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 4 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (e) ~70KB body with keyword at the very front + --depth standard -> true
# (SIGPIPE / 64KB pipe-buffer regression: here-string must not silently
#  false-negative when a downstream grep -q early-exits on a large upstream)
# ---------------------------------------------------------------------------
@test "standard depth: ~70KB body with leading keyword -> true (SIGPIPE regression)" {
    PAD="$(printf '%*s' 70000 '')"
    PAD="${PAD// /a}"
    BODY="${AC_STUB}breaking change needed"$'\n'"${PAD}"
    FIXTURE="$FIXTURE_DIR/large.json"
    make_fixture "$FIXTURE" "Large body issue" "$BODY"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 5 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (f) clean issue + --depth comprehensive -> breaking_keyword_scan key present,
#     legacy breaking_changes key absent
# ---------------------------------------------------------------------------
@test "comprehensive depth: clean issue -> breaking_keyword_scan present, breaking_changes absent" {
    FIXTURE="$FIXTURE_DIR/clean-comprehensive.json"
    make_fixture "$FIXTURE" "Add a button" "${COMPREHENSIVE_STUB}Just a UI tweak, nothing else."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 6 --depth comprehensive
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.breaking_keyword_scan == false) and (has("breaking_changes") | not)'
}

# ---------------------------------------------------------------------------
# (g) all outputs must be parseable JSON (checked implicitly by jq -e above,
#     plus explicit standard-depth clean-issue parse check)
# ---------------------------------------------------------------------------
@test "standard depth: clean issue output is valid JSON with breaking_keyword_scan:false" {
    FIXTURE="$FIXTURE_DIR/clean-standard.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 7 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == false'
}
