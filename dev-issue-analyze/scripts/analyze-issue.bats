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
    # make_fixture <path> <title> <body> [labels_json]
    local path="$1" title="$2" body="$3" labels="${4:-[]}"
    jq -n --arg title "$title" --arg body "$body" --argjson labels "$labels" \
        '{title: $title, state: "open", body: $body, labels: $labels, assignees: [], milestone: null}' \
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

# ===========================================================================
# --contract mode tests (issue #374): deterministic T1/T2 contract parse.
# ===========================================================================

# ---------------------------------------------------------------------------
# (h) T1: checkbox AC heading + feat: prefix -> contract=t1, eligible=true
# ---------------------------------------------------------------------------
@test "contract mode: checkbox AC heading + feat: prefix -> t1 eligible" {
    FIXTURE="$FIXTURE_DIR/contract-t1.json"
    make_fixture "$FIXTURE" "feat: add button" "## Acceptance Criteria

- [ ] item one
- [x] item two"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 10 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true and .issue_type == "feat"'
}

# ---------------------------------------------------------------------------
# (i) T2: plain-bullet 受け入れ基準 (JA) heading + fix: prefix -> t2, eligible=true
# ---------------------------------------------------------------------------
@test "contract mode: plain-bullet 受け入れ基準 (JA) heading + fix: prefix -> t2 eligible" {
    FIXTURE="$FIXTURE_DIR/contract-t2.json"
    make_fixture "$FIXTURE" "fix: correct typo" "## 受け入れ基準

- plain item 1
- plain item 2"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 11 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t2" and .eligible == true and .issue_type == "fix"'
}

# ---------------------------------------------------------------------------
# (j) no AC heading -> contract=none, eligible=false, exit 0 explicit
# ---------------------------------------------------------------------------
@test "contract mode: no AC heading -> none, ineligible, exit 0" {
    FIXTURE="$FIXTURE_DIR/contract-none.json"
    make_fixture "$FIXTURE" "feat: something" "Just prose, no AC heading anywhere."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 12 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found"'
}

# ---------------------------------------------------------------------------
# (k) AC heading present but no items -> contract=none, eligible=false
# ---------------------------------------------------------------------------
@test "contract mode: AC heading with no items -> none, ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-empty-ac.json"
    make_fixture "$FIXTURE" "feat: something" "## Acceptance Criteria

Some prose but no bullet points here.

## Next Section"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 13 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading found but no items"'
}

# ---------------------------------------------------------------------------
# (l) chore: prefix -> issue_type not in {feat,fix,docs,refactor} -> ineligible
# ---------------------------------------------------------------------------
@test "contract mode: chore: prefix title -> issue_type ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-chore.json"
    make_fixture "$FIXTURE" "chore: bump deps" "## Acceptance Criteria

- [ ] deps bumped"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 14 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == false and (.ineligible_reason | contains("issue_type"))'
}

# ---------------------------------------------------------------------------
# (m) feat!: breaking marker in title -> ineligible (breaking marker)
# ---------------------------------------------------------------------------
@test "contract mode: feat!: breaking marker in title -> ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-bang.json"
    make_fixture "$FIXTURE" "feat!: change API" "## Acceptance Criteria

- [ ] API changed"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 15 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == false and (.ineligible_reason | contains("breaking marker"))'
}

# ---------------------------------------------------------------------------
# (n) breaking keyword inside AC section (excluded from scope) still trips
#     the full-body breaking_keyword_scan -> ineligible
# ---------------------------------------------------------------------------
@test "contract mode: breaking keyword in AC-excluded section still detected -> ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-breaking-kw.json"
    make_fixture "$FIXTURE" "feat: update" "## Acceptance Criteria

- [ ] item with a breaking change noted here"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 16 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .eligible == false and .ineligible_reason == "breaking_keyword_scan true"'
}

# ---------------------------------------------------------------------------
# (o) title without conventional prefix -> label-based issue_type fallback
# ---------------------------------------------------------------------------
@test "contract mode: no title prefix -> label-based issue_type fallback" {
    FIXTURE="$FIXTURE_DIR/contract-label-fallback.json"
    make_fixture "$FIXTURE" "Something is broken" "## Acceptance Criteria

- [ ] it works again" '[{"name":"bug"}]'
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 17 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .issue_type == "fix"'
}

# ---------------------------------------------------------------------------
# (p) file paths outside AC section -> estimated_change_file_count present
# ---------------------------------------------------------------------------
@test "contract mode: file paths in scope -> estimated_change_file_count present" {
    FIXTURE="$FIXTURE_DIR/contract-file-count.json"
    make_fixture "$FIXTURE" "feat: touch files" "## Acceptance Criteria

- [ ] done

## Scope
Update src/foo.ts and src/bar.ts."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 18 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.estimated_change_file_count == 2'
}

# ---------------------------------------------------------------------------
# (q) file path mentioned only inside the AC section (excluded from scope)
#     -> estimated_change_file_count key absent (scope-boundary mismatch guard)
# ---------------------------------------------------------------------------
@test "contract mode: file path only inside AC section -> estimated_change_file_count absent" {
    FIXTURE="$FIXTURE_DIR/contract-file-in-ac-only.json"
    make_fixture "$FIXTURE" "feat: touch files" "## Acceptance Criteria

- [ ] update src/only-in-ac.ts

Just prose, no other files mentioned."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 19 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(has("estimated_change_file_count") | not)'
}

# ---------------------------------------------------------------------------
# (r) heading level agnostic: h4 "Acceptance Criteria" still recognized
# ---------------------------------------------------------------------------
@test "contract mode: h4 Acceptance Criteria heading recognized (h1-h6 agnostic)" {
    FIXTURE="$FIXTURE_DIR/contract-h4.json"
    make_fixture "$FIXTURE" "feat: deep heading" "#### Acceptance Criteria

- [ ] deep item"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 20 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true'
}

# ---------------------------------------------------------------------------
# (s) ~70KB body, breaking keyword after large padding -> exit 0, correctly
#     detected (SIGPIPE regression, contract-mode variant of the existing
#     depth-mode large-body test)
# ---------------------------------------------------------------------------
@test "contract mode: ~70KB body with trailing breaking keyword -> detected (SIGPIPE regression)" {
    PAD="$(printf '%*s' 70000 '')"
    PAD="${PAD// /a}"
    BODY="## Acceptance Criteria"$'\n\n'"- [ ] item"$'\n\n'"${PAD}"$'\n'"migration required afterward."
    FIXTURE="$FIXTURE_DIR/contract-large.json"
    make_fixture "$FIXTURE" "feat: large issue" "$BODY"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 21 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .breaking_keyword_scan == true and .eligible == false'
}

# ---------------------------------------------------------------------------
# (t) ineligible_reason key presence is exactly gated by eligible (absent
#     when eligible=true, present when eligible=false) -- valid JSON check
# ---------------------------------------------------------------------------
@test "contract mode: ineligible_reason key present only when eligible=false" {
    ELIGIBLE_FIXTURE="$FIXTURE_DIR/contract-key-eligible.json"
    make_fixture "$ELIGIBLE_FIXTURE" "docs: update readme" "## Acceptance Criteria

- [ ] readme updated"
    export GH_FIXTURE="$ELIGIBLE_FIXTURE"
    run "$SCRIPT" 22 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(has("ineligible_reason") | not)'

    INELIGIBLE_FIXTURE="$FIXTURE_DIR/contract-key-ineligible.json"
    make_fixture "$INELIGIBLE_FIXTURE" "no prefix title" "no AC heading here"
    export GH_FIXTURE="$INELIGIBLE_FIXTURE"
    run "$SCRIPT" 23 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("ineligible_reason")'
}

# ---------------------------------------------------------------------------
# (u) AC heading match must be EXACT, not substring: a sibling heading whose
#     text merely CONTAINS "受け入れ基準" (e.g. "受け入れ基準外") must NOT be
#     treated as the AC heading (PR #388 review finding, major #1).
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ基準外 heading (substring, not AC) -> not eligible" {
    FIXTURE="$FIXTURE_DIR/contract-ac-gaiku.json"
    make_fixture "$FIXTURE" "feat: something" "## 受け入れ基準外

- this must not be treated as an AC item"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 24 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found"'
}

# ---------------------------------------------------------------------------
# (v) A sibling heading that STARTS WITH the real AC heading text (e.g.
#     "受け入れ基準の補足") must not merge its items into the real AC section
#     (PR #388 review finding, major #1).
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ基準の補足 sibling heading does not merge into AC section" {
    FIXTURE="$FIXTURE_DIR/contract-ac-hosoku.json"
    make_fixture "$FIXTURE" "feat: something" "## 受け入れ基準

- [ ] real ac item

## 受け入れ基準の補足

- this must not merge into acceptance_criteria"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 25 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == ["real ac item"]'
}

# ---------------------------------------------------------------------------
# (w) File-extension whitelist must include shell/config extensions common in
#     this repo (sh/bats/mjs/...), not just general source extensions, so a
#     scope mentioning only .sh/.bats files still yields
#     estimated_change_file_count instead of spuriously falling into
#     classifyShape's complex floor (PR #388 review finding, major #2).
# ---------------------------------------------------------------------------
@test "contract mode: sh/bats-only scope -> estimated_change_file_count present" {
    FIXTURE="$FIXTURE_DIR/contract-sh-scope.json"
    make_fixture "$FIXTURE" "feat: touch shell files" "## Acceptance Criteria

- [ ] done

## Scope
Update dev-issue-analyze/scripts/analyze-issue.sh and dev-issue-analyze/scripts/analyze-issue.bats."
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 26 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.estimated_change_file_count == 2'
}

# ---------------------------------------------------------------------------
# (x) Multi-line non-AC body over 4000 bytes must not SIGPIPE-kill the script
#     via `extract_non_ac_body | head -c 4000` (PR #388 review finding,
#     critical #1). Regression: with the pipe form, head -c's early exit after
#     reading its byte quota SIGPIPEs the upstream printf writer under
#     set -o pipefail, causing exit 141 with empty stdout instead of exit 0 +
#     JSON. 200 lines x 30 chars (~6000 bytes incl. newlines) reproduces the
#     multi-write pattern that a single large single-line body does not.
# ---------------------------------------------------------------------------
@test "contract mode: multi-line non-AC scope over 4000 bytes -> exit 0, eligible" {
    LINES=""
    for i in $(seq 1 200); do
        LINES="${LINES}line-${i}-xxxxxxxxxxxxxxxxxxxx"$'\n'
    done
    BODY="## Acceptance Criteria

- [ ] item one

## Scope
${LINES}"
    FIXTURE="$FIXTURE_DIR/contract-large-scope.json"
    make_fixture "$FIXTURE" "feat: large scope" "$BODY"
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 27 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true'
}

# ---------------------------------------------------------------------------
# (y) A `# comment`-style line inside a fenced code block within the AC
#     section must not be mistaken for a markdown heading and prematurely
#     terminate the AC section (PR #388 review finding, major #1/fence
#     tracking). Without fence tracking, the fenced `# comment` line closes
#     the AC section early and "item two" (after the fence) is silently
#     dropped from acceptance_criteria.
# ---------------------------------------------------------------------------
@test "contract mode: '#' comment inside fenced code block in AC section does not truncate AC items" {
    FIXTURE="$FIXTURE_DIR/contract-fence.json"
    make_fixture "$FIXTURE" "feat: something with code fence" '## Acceptance Criteria

- [ ] item one

```
# comment not a heading
some code
```

- [ ] item two'
    export GH_FIXTURE="$FIXTURE"
    run "$SCRIPT" 28 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == ["item one", "item two"]'
}
