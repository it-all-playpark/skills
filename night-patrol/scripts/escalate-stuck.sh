#!/usr/bin/env bash
# escalate-stuck.sh - Label an issue as stuck and post a notification comment
#
# Invoked by night-patrol Phase 3 when failures.sh incr returns escalated: true.
# Adds the `patrol-stuck` label (creating it if absent) and posts a comment
# describing the failure streak so a human can take over.
#
# Usage:
#   escalate-stuck.sh <issue-number> [--reason "<msg>"] [--count N] [--dry-run]
#
# Config:
#   skill-config.json[night-patrol].stuck_label  (default: patrol-stuck)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

ISSUE=""
REASON=""
COUNT=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --reason) REASON="${2:-}"; shift 2 ;;
        --count)  COUNT="${2:-}"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *)
            if [[ -z "$ISSUE" ]]; then
                ISSUE="$1"
            fi
            shift
            ;;
    esac
done

[[ -n "$ISSUE" ]] || die_json "Issue number required" 1
[[ "$ISSUE" =~ ^[0-9]+$ ]] || die_json "Issue must be a positive integer: $ISSUE" 1

STUCK_LABEL=$(load_skill_config "night-patrol" | jq -r '.stuck_label // "patrol-stuck"')

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

BODY="night-patrol が execute phase で ${COUNT:-複数}回連続失敗したため \`${STUCK_LABEL}\` を付与しました。
- 検知時刻 (UTC): ${NOW}
- 直近の失敗理由: ${REASON:-N/A}

次回以降の自動実行ではこの issue はスキップされます。triage を手動で見直して原因を解消し、ラベルを外してください。"

if [[ "$DRY_RUN" == true ]]; then
    jq -nc \
        --arg issue "$ISSUE" \
        --arg label "$STUCK_LABEL" \
        --arg body "$BODY" \
        '{issue: ($issue | tonumber), status: "dry_run", label: $label, body: $body}'
    exit 0
fi

require_cmd gh

# Ensure label exists (idempotent). Ignore "already exists" errors.
gh label create "$STUCK_LABEL" \
    --description "night-patrol が自動 escalate したブロック状態 issue" \
    --color BFD4F2 >/dev/null 2>&1 || true

gh issue edit "$ISSUE" --add-label "$STUCK_LABEL" >/dev/null

gh issue comment "$ISSUE" --body "$BODY" >/dev/null

jq -nc \
    --arg issue "$ISSUE" \
    --arg label "$STUCK_LABEL" \
    '{issue: ($issue | tonumber), status: "escalated", label: $label}'
