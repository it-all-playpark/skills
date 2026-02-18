#!/usr/bin/env bash
# audit-state.sh - State management for code-audit-team skill
# Usage:
#   audit-state.sh init --target <target> --scope <scope> --focus <focus>
#   audit-state.sh add-finding --domain <d> --severity <s> --location <l> --title <t> --description <d> --evidence <e> [--cross-domain]
#   audit-state.sh add-cross-ref --finding <id> --ref <other-id>
#   audit-state.sh detect-hotspots
#   audit-state.sh read

set -euo pipefail
source "$(dirname "$0")/../../_lib/common.sh"

require_cmd "jq"

# State file location
STATE_DIR="${CWD:-.}/.claude"
STATE_FILE="${STATE_DIR}/audit-state.json"

# ============================================================================
# Commands
# ============================================================================

cmd_init() {
    local target="" scope="module" focus="all"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --target) target="$2"; shift 2 ;;
            --scope) scope="$2"; shift 2 ;;
            --focus) focus="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" ;;
        esac
    done

    [[ -z "$target" ]] && die_json "Missing required --target"

    mkdir -p "$STATE_DIR"

    # Build auditors object based on focus
    local auditors='{}'
    if [[ "$focus" == "all" || "$focus" == *"security"* ]]; then
        auditors=$(echo "$auditors" | jq '.["sec-auditor"] = {"status": "pending", "files_audited": 0, "findings_count": 0}')
    fi
    if [[ "$focus" == "all" || "$focus" == *"performance"* ]]; then
        auditors=$(echo "$auditors" | jq '.["perf-auditor"] = {"status": "pending", "files_audited": 0, "findings_count": 0}')
    fi
    if [[ "$focus" == "all" || "$focus" == *"architecture"* ]]; then
        auditors=$(echo "$auditors" | jq '.["arch-auditor"] = {"status": "pending", "files_audited": 0, "findings_count": 0}')
    fi

    jq -n \
        --arg target "$target" \
        --arg scope "$scope" \
        --arg focus "$focus" \
        --argjson auditors "$auditors" \
        '{
            version: "1.0.0",
            target: $target,
            scope: $scope,
            focus: $focus,
            status: "initializing",
            auditors: $auditors,
            findings: [],
            hotspots: [],
            action_plan: []
        }' > "$STATE_FILE"

    echo '{"status":"initialized","state_file":"'"$STATE_FILE"'"}'
}

cmd_add_finding() {
    local domain="" severity="" location="" title="" description="" evidence="" cross_domain="false"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --domain) domain="$2"; shift 2 ;;
            --severity) severity="$2"; shift 2 ;;
            --location) location="$2"; shift 2 ;;
            --title) title="$2"; shift 2 ;;
            --description) description="$2"; shift 2 ;;
            --evidence) evidence="$2"; shift 2 ;;
            --cross-domain) cross_domain="true"; shift ;;
            *) die_json "Unknown option: $1" ;;
        esac
    done

    [[ -z "$domain" ]] && die_json "Missing required --domain"
    [[ -z "$severity" ]] && die_json "Missing required --severity"
    [[ -z "$location" ]] && die_json "Missing required --location"
    [[ -z "$title" ]] && die_json "Missing required --title"

    [[ ! -f "$STATE_FILE" ]] && die_json "State not initialized. Run: audit-state.sh init first"

    # Generate finding ID
    local count
    count=$(jq '.findings | length' "$STATE_FILE")
    local finding_id="f$((count + 1))"

    # Severity to numeric score
    local severity_score=1
    case "$severity" in
        critical) severity_score=4 ;;
        high) severity_score=3 ;;
        medium) severity_score=2 ;;
        low) severity_score=1 ;;
    esac

    # Add finding to state
    local tmp
    tmp=$(mktemp)
    jq \
        --arg id "$finding_id" \
        --arg domain "$domain" \
        --arg severity "$severity" \
        --argjson severity_score "$severity_score" \
        --arg location "$location" \
        --arg title "$title" \
        --arg description "$description" \
        --arg evidence "$evidence" \
        --argjson cross_domain "$cross_domain" \
        '.findings += [{
            id: $id,
            domain: $domain,
            severity: $severity,
            severity_score: $severity_score,
            location: $location,
            title: $title,
            description: $description,
            evidence: $evidence,
            cross_domain: $cross_domain,
            cross_domain_refs: []
        }]' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"

    # Update auditor findings count
    local auditor_key=""
    case "$domain" in
        security) auditor_key="sec-auditor" ;;
        performance) auditor_key="perf-auditor" ;;
        architecture) auditor_key="arch-auditor" ;;
    esac

    if [[ -n "$auditor_key" ]]; then
        tmp=$(mktemp)
        jq --arg key "$auditor_key" \
            '.auditors[$key].findings_count += 1' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
    fi

    echo "{\"status\":\"added\",\"finding_id\":\"$finding_id\"}"
}

cmd_add_cross_ref() {
    local finding="" ref=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --finding) finding="$2"; shift 2 ;;
            --ref) ref="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" ;;
        esac
    done

    [[ -z "$finding" ]] && die_json "Missing required --finding"
    [[ -z "$ref" ]] && die_json "Missing required --ref"
    [[ ! -f "$STATE_FILE" ]] && die_json "State not initialized"

    # Add cross-reference to finding
    local tmp
    tmp=$(mktemp)
    jq --arg fid "$finding" --arg ref "$ref" \
        '(.findings[] | select(.id == $fid) | .cross_domain_refs) += [$ref]' \
        "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"

    # Also add reverse reference
    tmp=$(mktemp)
    jq --arg fid "$ref" --arg ref "$finding" \
        '(.findings[] | select(.id == $fid) | .cross_domain_refs) += [$ref]' \
        "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"

    echo "{\"status\":\"linked\",\"finding\":\"$finding\",\"ref\":\"$ref\"}"
}

cmd_detect_hotspots() {
    [[ ! -f "$STATE_FILE" ]] && die_json "State not initialized"

    # Find locations with findings from multiple domains
    local tmp
    tmp=$(mktemp)
    jq '
        # Extract file path (without line number) from location for grouping
        [.findings[] | {
            file: (.location | split(":")[0]),
            domain: .domain,
            id: .id,
            severity: .severity,
            severity_score: .severity_score,
            title: .title
        }]
        | group_by(.file)
        | map(select(([.[].domain] | unique | length) > 1))
        | map({
            location: .[0].file,
            domains: ([.[].domain] | unique),
            domain_count: ([.[].domain] | unique | length),
            findings: [.[].id],
            max_severity: (map(.severity_score) | max),
            cross_multiplier: (if ([.[].domain] | unique | length) >= 3 then 2.0
                              elif ([.[].domain] | unique | length) == 2 then 1.5
                              else 1.0 end),
            combined_severity: (
                (map(.severity_score) | max) *
                (if ([.[].domain] | unique | length) >= 3 then 2.0
                 elif ([.[].domain] | unique | length) == 2 then 1.5
                 else 1.0 end)
            )
        })
        | sort_by(-.combined_severity)
    ' "$STATE_FILE" > "$tmp"

    # Update state with hotspots
    local hotspots
    hotspots=$(cat "$tmp")
    rm -f "$tmp"

    tmp=$(mktemp)
    jq --argjson hotspots "$hotspots" '.hotspots = $hotspots' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"

    echo "$hotspots"
}

cmd_read() {
    [[ ! -f "$STATE_FILE" ]] && die_json "State not initialized"
    cat "$STATE_FILE"
}

# ============================================================================
# Main
# ============================================================================

main() {
    [[ $# -lt 1 ]] && die_json "Usage: audit-state.sh <command> [options]"

    local cmd="$1"
    shift

    case "$cmd" in
        init) cmd_init "$@" ;;
        add-finding) cmd_add_finding "$@" ;;
        add-cross-ref) cmd_add_cross_ref "$@" ;;
        detect-hotspots) cmd_detect_hotspots ;;
        read) cmd_read ;;
        *) die_json "Unknown command: $cmd. Must be one of: init, add-finding, add-cross-ref, detect-hotspots, read" ;;
    esac
}

main "$@"
