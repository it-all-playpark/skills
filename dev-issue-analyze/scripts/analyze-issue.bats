#!/usr/bin/env bats
# Tests for dev-issue-analyze/scripts/analyze-issue.sh
#
# Strategy: analyze-issue.sh is a pure transform over a pre-fetched issue
# JSON file (contract: verbatim stdout of
# `gh issue view <n> --json body,title,labels,assignees,milestone,state`).
# Each test writes a fixture file and passes it via --issue-json; no gh
# stub is needed (the script performs no gh/network I/O).
#
# Covers: breaking_keyword_scan determinism across all depths (minimal /
# standard / comprehensive), full-body scan beyond the 500-char body_preview
# boundary, Japanese keyword detection, a >64KB body regression to pin
# the here-string (non-pipe) SIGPIPE-safe implementation, and --issue-json
# argument validation (missing flag / missing file).

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-issue-analyze/scripts/analyze-issue.sh"

    FIXTURE_DIR="$BATS_TMPDIR/fixtures"
    mkdir -p "$FIXTURE_DIR"
}

make_fixture() {
    # make_fixture <path> <title> <body> [labels_json] [comments_json]
    local path="$1" title="$2" body="$3" labels="${4:-[]}" comments="${5:-[]}"
    jq -n --arg title "$title" --arg body "$body" --argjson labels "$labels" --argjson comments "$comments" \
        '{title: $title, state: "open", body: $body, labels: $labels, assignees: [], milestone: null, comments: $comments}' \
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
    run "$SCRIPT" 1 --issue-json "$FIXTURE" --depth minimal
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
    run "$SCRIPT" 2 --issue-json "$FIXTURE" --depth minimal
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
    run "$SCRIPT" 3 --issue-json "$FIXTURE" --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (d) Japanese keyword 破壊的変更 + --depth standard -> true
# ---------------------------------------------------------------------------
@test "standard depth: Japanese keyword 破壊的変更 -> true" {
    FIXTURE="$FIXTURE_DIR/ja.json"
    make_fixture "$FIXTURE" "スキーマ更新" "${AC_STUB}この変更には破壊的変更が含まれます。"
    run "$SCRIPT" 4 --issue-json "$FIXTURE" --depth standard
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
    run "$SCRIPT" 5 --issue-json "$FIXTURE" --depth standard
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
    run "$SCRIPT" 6 --issue-json "$FIXTURE" --depth comprehensive
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
    run "$SCRIPT" 7 --issue-json "$FIXTURE" --depth standard
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
    run "$SCRIPT" 10 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 11 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t2" and .eligible == true and .issue_type == "fix"'
}

# ---------------------------------------------------------------------------
# (j) no AC heading -> contract=none, eligible=false, exit 0 explicit
# ---------------------------------------------------------------------------
@test "contract mode: no AC heading -> none, ineligible, exit 0" {
    FIXTURE="$FIXTURE_DIR/contract-none.json"
    make_fixture "$FIXTURE" "feat: something" "Just prose, no AC heading anywhere."
    run "$SCRIPT" 12 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 13 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading found but no items"'
}

# ---------------------------------------------------------------------------
# (l) chore: prefix -> issue_type in {feat,fix,docs,refactor,chore,test,perf,ci}
#     -> eligible (issue #442 enum 拡張)
# ---------------------------------------------------------------------------
@test "contract mode: chore: prefix title -> eligible (issue #442 enum 拡張)" {
    FIXTURE="$FIXTURE_DIR/contract-chore.json"
    make_fixture "$FIXTURE" "chore: bump deps" "## Acceptance Criteria

- [ ] deps bumped"
    run "$SCRIPT" 14 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .issue_type == "chore"'
}

# ---------------------------------------------------------------------------
# (l2) style: prefix -> issue_type not in enum -> ineligible (out-of-enum
#      regression coverage now that chore is valid; 'style' stays out-of-enum)
# ---------------------------------------------------------------------------
@test "contract mode: style: prefix title -> ineligible (out-of-enum)" {
    FIXTURE="$FIXTURE_DIR/contract-style.json"
    make_fixture "$FIXTURE" "style: tweak css" "## Acceptance Criteria

- [ ] css tweaked"
    run "$SCRIPT" 29 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == false and (.ineligible_reason | contains("issue_type"))'
}

# ---------------------------------------------------------------------------
# (l3) test: prefix -> issue_type in enum -> eligible (bash reserved-word /
#      `test` command name collision check, issue #442)
# ---------------------------------------------------------------------------
@test "contract mode: test: prefix title -> eligible (issue #442 enum 拡張)" {
    FIXTURE="$FIXTURE_DIR/contract-test-type.json"
    make_fixture "$FIXTURE" "test: add regression spec" "## Acceptance Criteria

- [ ] regression spec added"
    run "$SCRIPT" 30 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .issue_type == "test"'
}

# ---------------------------------------------------------------------------
# (m) feat!: breaking marker in title -> ineligible (breaking marker)
# ---------------------------------------------------------------------------
@test "contract mode: feat!: breaking marker in title -> ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-bang.json"
    make_fixture "$FIXTURE" "feat!: change API" "## Acceptance Criteria

- [ ] API changed"
    run "$SCRIPT" 15 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 16 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 17 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 18 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 19 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 20 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 21 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 22 --issue-json "$ELIGIBLE_FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(has("ineligible_reason") | not)'

    INELIGIBLE_FIXTURE="$FIXTURE_DIR/contract-key-ineligible.json"
    make_fixture "$INELIGIBLE_FIXTURE" "no prefix title" "no AC heading here"
    run "$SCRIPT" 23 --issue-json "$INELIGIBLE_FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("ineligible_reason")'
}

# ---------------------------------------------------------------------------
# (u) AC heading match mirrors ac-lint.sh's HEADING_RE (substring, not exact-line):
#     a sibling heading whose text merely CONTAINS "受け入れ基準" (e.g. "受け入れ
#     基準外") IS treated as the AC heading here, same as ac-lint.sh's real
#     contract gate (verified empirically: ac-lint.sh returns verdict=t2 for this
#     exact fixture) — the PR #388 exact-match rationale is superseded by the
#     issue #573 review finding that the two must agree or silently diverge.
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ基準外 heading (substring) -> eligible, matches ac-lint" {
    FIXTURE="$FIXTURE_DIR/contract-ac-gaiku.json"
    make_fixture "$FIXTURE" "feat: something" "## 受け入れ基準外

- this is now treated as an AC item, same as ac-lint.sh"
    run "$SCRIPT" 24 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t2" and .eligible == true'
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
    run "$SCRIPT" 25 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 26 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 27 --issue-json "$FIXTURE" --contract
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
    run "$SCRIPT" 28 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == ["item one", "item two"]'
}

# ===========================================================================
# --issue-json argument validation
# ===========================================================================

# ---------------------------------------------------------------------------
# (z1) --issue-json omitted -> die_json (required option)
# ---------------------------------------------------------------------------
@test "--issue-json omitted -> die_json required option" {
    run "$SCRIPT" 31 --depth minimal
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.status == "error" and (.error | contains("--issue-json"))'
}

# ---------------------------------------------------------------------------
# (z2) --issue-json points at a nonexistent file -> die_json
# ---------------------------------------------------------------------------
@test "--issue-json file does not exist -> die_json" {
    run "$SCRIPT" 32 --issue-json "$FIXTURE_DIR/does-not-exist.json" --depth minimal
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.status == "error"'
}

# ===========================================================================
# comments / AC heading near-miss (issue #573)
# ===========================================================================

# ---------------------------------------------------------------------------
# (aa1) contract mode: comments present -> ineligible (comment/body reconciliation
#       requires sonnet analyze; comment_count reported)
# ---------------------------------------------------------------------------
@test "contract mode: comments present -> ineligible, comment_count reported" {
    FIXTURE="$FIXTURE_DIR/contract-comments.json"
    make_fixture "$FIXTURE" "feat: add button" "## Acceptance Criteria

- [ ] item one" '[]' '[{"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"},{"author":{"login":"bob"},"createdAt":"2026-01-02T00:00:00Z","body":"了解"}]'
    run "$SCRIPT" 33 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == false and .comment_count == 2 and (.ineligible_reason | startswith("comments present (2)"))'
}

# ---------------------------------------------------------------------------
# (aa2) contract mode: 受け入れ条件 heading + checkbox + fix: prefix, no comments
#       -> eligible, comment_count 0, ac_heading_near_miss empty
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ条件 heading -> eligible, no comments" {
    FIXTURE="$FIXTURE_DIR/contract-ukeire-jouken.json"
    make_fixture "$FIXTURE" "fix: correct typo" "## 受け入れ条件

- [ ] item one"
    run "$SCRIPT" 34 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true and .comment_count == 0 and .ac_heading_near_miss == []'
}

# ---------------------------------------------------------------------------
# (aa3) contract mode: 受入条件 heading (without け/え — NOT an accepted form,
#       same as ac-lint.sh which also rejects it; verified empirically: ac-lint.sh
#       returns heading_found=false/non_compliant for this exact fixture) + plain
#       bullets -> ineligible, reported as near-miss (issue #573 review: this used
#       to be silently accepted here while ac-lint.sh disagreed)
# ---------------------------------------------------------------------------
@test "contract mode: 受入条件 heading (no け/え, out of accepted forms) -> near-miss reported" {
    FIXTURE="$FIXTURE_DIR/contract-ukeire-jouken2.json"
    make_fixture "$FIXTURE" "feat: something" "## 受入条件

- plain item"
    run "$SCRIPT" 35 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found" and .ac_heading_near_miss == ["## 受入条件"]'
}

# ---------------------------------------------------------------------------
# (aa4) contract mode: 受入れ要件 heading (not an accepted form) + checkbox
#       -> contract none, ineligible, reported as near-miss
# ---------------------------------------------------------------------------
@test "contract mode: 受入れ要件 heading (out of accepted forms) -> near-miss reported" {
    FIXTURE="$FIXTURE_DIR/contract-ukeire-youken.json"
    make_fixture "$FIXTURE" "feat: something" "## 受入れ要件

- [ ] item one"
    run "$SCRIPT" 36 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found" and .ac_heading_near_miss == ["## 受入れ要件"]'
}

# ---------------------------------------------------------------------------
# (aa5) contract mode: 受け入れ基準外 heading -> NOT a near-miss (it is now an
#       accepted AC heading itself, same as ac-lint.sh; see test (u) above).
#       collect_ac_near_miss must not double-report an already-accepted heading.
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ基準外 heading -> accepted heading, not double-reported as near-miss" {
    FIXTURE="$FIXTURE_DIR/contract-ac-gaiku-nearmiss.json"
    make_fixture "$FIXTURE" "feat: something" "## 受け入れ基準外

- this is now treated as an AC item, same as ac-lint.sh"
    run "$SCRIPT" 37 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ac_heading_near_miss == [] and .contract == "t2" and .eligible == true'
}

# ---------------------------------------------------------------------------
# (aa6) contract mode: '#' comment inside fenced code block ("# acceptance notes")
#       is not treated as a near-miss heading
# ---------------------------------------------------------------------------
@test "contract mode: fenced '# acceptance notes' line is not a near-miss" {
    FIXTURE="$FIXTURE_DIR/contract-fence-nearmiss.json"
    make_fixture "$FIXTURE" "feat: something" '## Acceptance Criteria

- [ ] item one

```
# acceptance notes
some code
```'
    run "$SCRIPT" 38 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ac_heading_near_miss == []'
}

# ---------------------------------------------------------------------------
# (aa7) standard depth: comments -> comment_count + comments[] populated
# ---------------------------------------------------------------------------
@test "standard depth: comments populated in output" {
    FIXTURE="$FIXTURE_DIR/standard-comments.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else." '[]' '[{"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"}]'
    run "$SCRIPT" 39 --issue-json "$FIXTURE" --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_count == 1 and .comments[0].author == "alice" and .comments[0].created_at == "2026-01-01T00:00:00Z" and .comments[0].body == "訂正: 30 箇所"'
}

# ---------------------------------------------------------------------------
# (aa8) standard depth: no AC lines in body -> acceptance_criteria empty,
#       warnings include the empty-AC message and the near-miss heading text
# ---------------------------------------------------------------------------
@test "standard depth: no AC lines -> warnings report empty AC and near-miss heading" {
    FIXTURE="$FIXTURE_DIR/standard-no-ac.json"
    make_fixture "$FIXTURE" "feat: something" "## 受入れ要件

Just prose, no checkbox or numbered items here."
    run "$SCRIPT" 40 --issue-json "$FIXTURE" --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == [] and (.warnings | any(startswith("acceptance_criteria is empty"))) and (.warnings | any(contains("受入れ要件")))'
}

# ---------------------------------------------------------------------------
# (aa9) standard depth: AC present, no near-miss heading -> warnings empty
# ---------------------------------------------------------------------------
@test "standard depth: AC present, no near-miss -> warnings empty" {
    FIXTURE="$FIXTURE_DIR/standard-warnings-empty.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else."
    run "$SCRIPT" 41 --issue-json "$FIXTURE" --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.warnings == []'
}

# ---------------------------------------------------------------------------
# (aa10) minimal depth: comment_count reflects comments length
# ---------------------------------------------------------------------------
@test "minimal depth: comment_count reflects comments length" {
    FIXTURE="$FIXTURE_DIR/minimal-comments.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak, nothing else." '[]' '[{"author":{"login":"a"},"createdAt":"2026-01-01T00:00:00Z","body":"1"},{"author":{"login":"b"},"createdAt":"2026-01-02T00:00:00Z","body":"2"},{"author":{"login":"c"},"createdAt":"2026-01-03T00:00:00Z","body":"3"}]'
    run "$SCRIPT" 42 --issue-json "$FIXTURE" --depth minimal
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_count == 3'
}

# ---------------------------------------------------------------------------
# (aa11) fixture with no "comments" key at all (legacy shape) -> comment_count 0,
#        contract mode remains eligible
# ---------------------------------------------------------------------------
@test "fixture without comments key -> comment_count 0, contract eligible" {
    FIXTURE="$FIXTURE_DIR/contract-no-comments-key.json"
    jq -n --arg title "feat: add button" --arg body "## Acceptance Criteria

- [ ] item one" \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null} | del(.comments)' \
        > "$FIXTURE"
    run "$SCRIPT" 43 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .comment_count == 0'
}

# ===========================================================================
# ac-lint.sh HEADING_RE alignment (PR #578 review of #573's contract)
# ===========================================================================

# ---------------------------------------------------------------------------
# (ab1) contract mode: 完了条件 heading + checkbox -> t1 eligible. Regression
#       fixture for the review finding: ac-lint.sh accepts "## 完了条件" as an
#       AC heading (verified empirically: verdict=t1) but AC_HEADING_LINE_RE
#       did not include it before this fix, silently failing AC3.
# ---------------------------------------------------------------------------
@test "contract mode: 完了条件 heading + checkbox -> t1 eligible, matches ac-lint" {
    FIXTURE="$FIXTURE_DIR/contract-kanryo-jouken.json"
    make_fixture "$FIXTURE" "feat: something" "## 完了条件

- [ ] item one"
    run "$SCRIPT" 44 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true'
}

# ---------------------------------------------------------------------------
# (ab2) contract mode: orchestrator-rescue-inserted heading with a trailing
#       parenthesized annotation ("## 受け入れ基準（Acceptance Criteria）") ->
#       t1 eligible. Regression fixture for the review finding: ac-lint.sh
#       accepts this heading (trailing text is not required to end the line;
#       verified empirically: verdict=t1) but the previous exact-end-anchored
#       AC_HEADING_LINE_RE rejected it, silently failing AC3.
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ基準（Acceptance Criteria） heading -> t1 eligible, matches ac-lint" {
    FIXTURE="$FIXTURE_DIR/contract-rescue-heading.json"
    make_fixture "$FIXTURE" "feat: something" "## 受け入れ基準（Acceptance Criteria）

- [ ] item one"
    run "$SCRIPT" 45 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true'
}

# ---------------------------------------------------------------------------
# (ab3) contract mode: 完了基準 heading (not an accepted form — only 完了条件
#       is, same as ac-lint.sh) -> ineligible, reported as near-miss via the
#       AC_NEAR_MISS_RE 完了条件|完了基準 addition.
# ---------------------------------------------------------------------------
@test "contract mode: 完了基準 heading (out of accepted forms) -> near-miss reported" {
    FIXTURE="$FIXTURE_DIR/contract-kanryo-kijun.json"
    make_fixture "$FIXTURE" "feat: something" "## 完了基準

- [ ] item one"
    run "$SCRIPT" 46 --issue-json "$FIXTURE" --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found" and .ac_heading_near_miss == ["## 完了基準"]'
}
