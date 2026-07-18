#!/usr/bin/env bash
# analyze-issue.sh - Fetch and parse GitHub issue

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_gh_auth
require_cmd "jq" "jq is required for JSON parsing. Install: brew install jq"

# Shared file-extension whitelist for affected-file scanning (contract-mode scope scan
# and comprehensive-mode AFFECTED_FILES). Includes scripting/config extensions common in
# this repo (sh/bats/mjs/json/...) in addition to general source extensions, so issues that
# only mention shell/workflow/config files still yield a non-empty estimated_change_file_count
# instead of spuriously triggering classifyShape's complex floor (issue #388 review).
FILE_EXT_PATTERN='ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|sh|bash|bats|json|yml|yaml|toml'

ISSUE_NUMBER=""
DEPTH="standard"
CONTRACT_MODE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --depth) DEPTH="$2"; shift 2 ;;
        --contract) CONTRACT_MODE=true; shift ;;
        -h|--help)
            echo "Usage: analyze-issue.sh <issue-number> [--depth minimal|standard|comprehensive] [--contract]"
            exit 0
            ;;
        -*)
            die_json "Unknown option: $1"
            ;;
        *)
            [[ -z "$ISSUE_NUMBER" ]] && ISSUE_NUMBER="$1"
            shift
            ;;
    esac
done

[[ -z "$ISSUE_NUMBER" ]] && die_json "Issue number required"

# Fetch issue
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --json body,title,labels,assignees,milestone,state 2>&1) || \
    die_json "Failed to fetch issue #$ISSUE_NUMBER. Check if issue exists and you have access."

# Extract fields
TITLE=$(echo "$ISSUE_JSON" | jq -r '.title // ""')
STATE=$(echo "$ISSUE_JSON" | jq -r '.state // "unknown"')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body // ""')
LABELS=$(echo "$ISSUE_JSON" | jq -c '[.labels[].name] // []')
MILESTONE=$(echo "$ISSUE_JSON" | jq -r '.milestone.title // null')

# Detect type from labels
detect_type() {
    local labels="$1"
    if echo "$labels" | grep -qi "bug"; then echo "fix"
    elif echo "$labels" | grep -qi "enhancement\|feature"; then echo "feat"
    elif echo "$labels" | grep -qi "refactor"; then echo "refactor"
    elif echo "$labels" | grep -qi "doc"; then echo "docs"
    else echo "feat"
    fi
}

TYPE=$(detect_type "$LABELS")

# Breaking keyword scan (deterministic floor, applies to all depths).
# NOTE: uses a here-string (not a pipe) so grep -q's early-exit on match
# cannot cause an upstream SIGPIPE / silent false negative on large bodies.
BREAKING_KEYWORD_SCAN="false"
grep -qiE 'breaking|incompatible|migration|破壊的|非互換' <<<"${TITLE}"$'\n'"${BODY}" && BREAKING_KEYWORD_SCAN="true"

# ============================================================
# Contract mode (--contract): deterministic T1/T2 contract parse (issue #374)
# ============================================================
# T1 = AC heading (h1-h6, "Acceptance Criteria" / "受け入れ基準" etc.) + >=1 checkbox item.
# T2 = same heading + >=1 plain bullet/numbered item (no checkbox).
# Eligible only when contract in {t1,t2}, issue_type (title prefix -> label fallback) is in
# {feat,fix,docs,refactor}, no `!` breaking marker in title, and breaking_keyword_scan==false.
# Ineligible/unparseable => eligible:false + ineligible_reason (exit 0; caller falls back to
# the existing sonnet(dev-runner) analyze path — this is a fail-open speed optimization only).

# Line-anchored regex matching a markdown heading whose text (after optional trailing
# ':'/'：') is EXACTLY "acceptance criteria" (case-insensitive) or "受け入れ基準" — not
# a substring match, so sibling headings like "受け入れ基準外" or "受け入れ基準の補足"
# do not match and their content is never folded into the AC section (issue #388 review).
# NOTE: implemented with grep -E (not awk ==) — macOS's bundled awk (one true awk
# 20200816) has a confirmed locale-dependent bug where `==` between two non-identical
# multibyte Japanese strings (e.g. "受け入れ基準外" vs "受け入れ基準") spuriously
# returns true, so awk string-equality cannot be trusted for this comparison here.
AC_HEADING_LINE_RE='^#{1,6}[[:space:]]+(acceptance criteria|受け入れ基準)[[:space:]]*[:：]?[[:space:]]*$'
HEADING_LINE_RE='^#{1,6}[[:space:]]+'
# Fenced code block delimiter: ``` or ~~~ (>=3 chars), optionally indented up to 3 spaces
# per CommonMark. Used to toggle fence state so lines inside a fenced code block (e.g. a
# `# comment` in a shell snippet) are never mistaken for markdown headings (issue #388 review).
FENCE_LINE_RE='^[[:space:]]{0,3}(```+|~~~+)'

is_ac_heading_line() { grep -qiE "$AC_HEADING_LINE_RE" <<<"$1"; }
is_heading_line() { grep -qE "$HEADING_LINE_RE" <<<"$1"; }
is_fence_line() { grep -qE "$FENCE_LINE_RE" <<<"$1"; }

# Extracts the body lines that fall under the AC heading (heading line itself excluded,
# section ends at the next heading of any level or EOF). Empty when no AC heading found.
# Tracks fenced-code-block state so heading detection is skipped for lines inside a fence
# (a `# comment` line inside a ```code block``` in the AC section must not be treated as a
# heading and prematurely close the AC section).
# NOTE: reads via a here-string / `read` loop (not a pipe) for the same SIGPIPE-safety
# reason as breaking_keyword_scan above.
extract_ac_section() {
    local body="$1" skip=false in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            [[ "$skip" == true ]] && printf '%s\n' "$line"
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line"; then
            if is_ac_heading_line "$line"; then skip=true; else skip=false; fi
            continue
        fi
        if [[ "$skip" == true ]]; then printf '%s\n' "$line"; fi
    done <<<"$body"
    return 0
}

# Returns the body with the AC heading + its section removed (everything else preserved).
# Same fence-tracking as extract_ac_section (issue #388 review).
extract_non_ac_body() {
    local body="$1" skip=false in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            [[ "$skip" == true ]] && continue
            printf '%s\n' "$line"
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line"; then
            if is_ac_heading_line "$line"; then skip=true; continue; else skip=false; fi
        fi
        if [[ "$skip" == true ]]; then continue; fi
        printf '%s\n' "$line"
    done <<<"$body"
    return 0
}

# Extracts item text (marker stripped, blank lines dropped) from an AC section.
# mode="checkbox" -> `- [ ]`/`- [x]` items only. mode="plain" -> `- `/`* `/numbered items.
# NOTE: `|| true` on the grep stages so a no-match (exit 1) doesn't kill the script under
# set -e + pipefail; the function's last stage is itself `|| true`-guarded so its own exit
# status is always 0 regardless of match count.
extract_contract_ac_items() {
    local ac_section="$1" mode="$2"
    if [[ "$mode" == "checkbox" ]]; then
        { grep -E '^[[:space:]]*[-*][[:space:]]*\[[ xX]\][[:space:]]*' <<<"$ac_section" || true; } \
            | sed -E 's/^[[:space:]]*[-*][[:space:]]*\[[ xX]\][[:space:]]*//' \
            | { grep -v '^[[:space:]]*$' || true; }
    else
        { grep -E '^[[:space:]]*([-*][[:space:]]+|[0-9]+\.[[:space:]]+)' <<<"$ac_section" || true; } \
            | sed -E 's/^[[:space:]]*([-*][[:space:]]+|[0-9]+\.[[:space:]]+)//' \
            | { grep -v '^[[:space:]]*$' || true; }
    fi
}

run_contract_mode() {
    local heading_found=false in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line" && is_ac_heading_line "$line"; then
            heading_found=true
            break
        fi
    done <<<"$BODY"

    local contract="none" eligible=true ineligible_reason="" ac_items="" ac_section=""

    if [[ "$heading_found" != true ]]; then
        eligible=false
        ineligible_reason="AC heading not found"
    else
        ac_section="$(extract_ac_section "$BODY")"
        local checkbox_items checkbox_count
        checkbox_items="$(extract_contract_ac_items "$ac_section" checkbox)"
        checkbox_count=$(printf '%s\n' "$checkbox_items" | grep -c '^.' || true)
        if (( checkbox_count >= 1 )); then
            contract="t1"
            ac_items="$checkbox_items"
        else
            local plain_items plain_count
            plain_items="$(extract_contract_ac_items "$ac_section" plain)"
            plain_count=$(printf '%s\n' "$plain_items" | grep -c '^.' || true)
            if (( plain_count >= 1 )); then
                contract="t2"
                ac_items="$plain_items"
            else
                eligible=false
                ineligible_reason="AC heading found but no items"
            fi
        fi
    fi

    # issue_type: conventional-commit title prefix (e.g. `feat:`, `fix(scope)!:`) takes
    # precedence; falls back to label-based detect_type when the title has no such prefix.
    local title_type="" title_bang="false" issue_type
    local title_re='^([A-Za-z]+)(\([^)]*\))?(!)?:[[:space:]]'
    if [[ "$TITLE" =~ $title_re ]]; then
        title_type="$(tr '[:upper:]' '[:lower:]' <<<"${BASH_REMATCH[1]}")"
        [[ -n "${BASH_REMATCH[3]}" ]] && title_bang="true"
    fi
    if [[ -n "$title_type" ]]; then
        issue_type="$title_type"
    else
        issue_type="$TYPE"
    fi

    if [[ "$eligible" == true ]]; then
        case "$issue_type" in
            feat|fix|docs|refactor) ;;
            *)
                eligible=false
                ineligible_reason="issue_type '$issue_type' not in {feat,fix,docs,refactor}"
                ;;
        esac
    fi

    if [[ "$eligible" == true && "$title_bang" == true ]]; then
        eligible=false
        ineligible_reason="breaking marker (!) in title"
    fi

    if [[ "$eligible" == true && "$BREAKING_KEYWORD_SCAN" == "true" ]]; then
        eligible=false
        ineligible_reason="breaking_keyword_scan true"
    fi

    local scope_full scope scope_files_count
    # NOTE: no pipe into `head -c` here — for multi-line non-AC bodies over 4000 bytes,
    # `head -c` early-exits after reading its byte quota and SIGPIPEs the upstream
    # extract_non_ac_body writer (printf), which under set -o pipefail kills the whole
    # script (exit 141) before the JSON is emitted, violating the "exit 0 + JSON" contract
    # (issue #388 review). Capture full output first, then substring in bash (no pipe).
    scope_full="$(extract_non_ac_body "$BODY")"
    scope="${scope_full:0:4000}"
    scope_files_count=$({ grep -oE "[a-zA-Z0-9_/-]+\\.($FILE_EXT_PATTERN)" <<<"$scope" || true; } | sort -u | grep -c '^.' || true)

    local ac_items_json
    ac_items_json=$(printf '%s\n' "$ac_items" | grep -v '^[[:space:]]*$' | head -20 | json_array || true)
    [[ -z "$ac_items_json" ]] && ac_items_json="[]"

    jq -n \
        --arg contract "$contract" \
        --argjson eligible "$eligible" \
        --arg ineligible_reason "$ineligible_reason" \
        --argjson issue_number "$ISSUE_NUMBER" \
        --arg title "$TITLE" \
        --arg issue_type "$issue_type" \
        --argjson acceptance_criteria "$ac_items_json" \
        --arg scope "$scope" \
        --argjson breaking_keyword_scan "$BREAKING_KEYWORD_SCAN" \
        --argjson has_file_count "$([[ "$scope_files_count" -gt 0 ]] && echo true || echo false)" \
        --argjson file_count "$scope_files_count" \
        '
        {
          contract: $contract,
          eligible: $eligible,
          issue_number: $issue_number,
          title: $title,
          issue_type: $issue_type,
          acceptance_criteria: $acceptance_criteria,
          scope: $scope,
          breaking_keyword_scan: $breaking_keyword_scan
        }
        + (if $eligible then {} else {ineligible_reason: $ineligible_reason} end)
        + (if $has_file_count then {estimated_change_file_count: $file_count} else {} end)
        '
}

if [[ "$CONTRACT_MODE" == true ]]; then
    run_contract_mode
    exit 0
fi

# Minimal output
if [[ "$DEPTH" == "minimal" ]]; then
    echo "{\"issue_number\":$ISSUE_NUMBER,\"title\":$(json_str "$TITLE"),\"type\":\"$TYPE\",\"state\":\"$STATE\",\"labels\":$LABELS,\"milestone\":$(json_str "$MILESTONE"),\"breaking_keyword_scan\":$BREAKING_KEYWORD_SCAN}"
    exit 0
fi

# Extract AC and requirements
# NOTE: uses here-strings (not pipes) for the same SIGPIPE-safety reason as
# breaking_keyword_scan above — a large $1 fed through a pipe into a
# downstream head -N that early-exits can SIGPIPE-kill the upstream writer.
# NOTE: `|| true` because a no-match grep exits 1, which under
# set -e + pipefail kills the whole script with no output.
extract_ac() {
    { grep -E '^\s*-\s*\[[ x]\]|^[0-9]+\.\s' <<<"$1" || true; } | head -20 | json_array
}

extract_requirements() {
    { grep -E '^\s*[-*]\s+[A-Z]' <<<"$1" || true; } | head -15 | json_array
}

AC=$(extract_ac "$BODY")
REQUIREMENTS=$(extract_requirements "$BODY")

# Standard output
if [[ "$DEPTH" == "standard" ]]; then
    cat <<JSONEOF
{
  "issue_number": $ISSUE_NUMBER,
  "title": $(json_str "$TITLE"),
  "type": "$TYPE",
  "state": "$STATE",
  "labels": $LABELS,
  "milestone": $(json_str "$MILESTONE"),
  "acceptance_criteria": $AC,
  "requirements": $REQUIREMENTS,
  "breaking_keyword_scan": $BREAKING_KEYWORD_SCAN,
  "body_preview": $(head -c 500 <<<"$BODY" | jq -Rs .)
}
JSONEOF
    exit 0
fi

# Comprehensive
# NOTE: `|| true` for the same no-match reason as extract_ac above.
AFFECTED_FILES=$({ grep -oE "[a-zA-Z0-9_/-]+\\.($FILE_EXT_PATTERN)" <<<"$BODY" || true; } | sort -u | head -10 | json_array)
COMPONENTS=$({ grep -oE '\b[A-Z][a-zA-Z]+Component\b|\b[a-z]+Service\b' <<<"$BODY" || true; } | sort -u | head -10 | json_array)

cat <<JSONEOF
{
  "issue_number": $ISSUE_NUMBER,
  "title": $(json_str "$TITLE"),
  "type": "$TYPE",
  "state": "$STATE",
  "labels": $LABELS,
  "milestone": $(json_str "$MILESTONE"),
  "acceptance_criteria": $AC,
  "requirements": $REQUIREMENTS,
  "affected_files": $AFFECTED_FILES,
  "components": $COMPONENTS,
  "breaking_keyword_scan": $BREAKING_KEYWORD_SCAN,
  "body_full": $(printf '%s' "$BODY" | jq -Rs .)
}
JSONEOF
