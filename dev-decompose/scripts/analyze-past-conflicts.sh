#!/usr/bin/env bash
# analyze-past-conflicts.sh - Extract recurring conflict hints from
# _shared/integration-feedback.json for dev-decompose --dry-run.
#
# Given the set of files a new decomposition is about to touch, this script
# reads the last N integration-feedback events and reports:
#
#   - files that appear in multiple historical conflicts
#   - directory prefixes (one level up) that repeatedly collide
#   - lessons captured for those files/prefixes (most recent first)
#
# Output is informational: dev-decompose uses it to bias subtask grouping but
# the decomposer LLM still makes the final call.
#
# Usage:
#   analyze-past-conflicts.sh --affected-files F1,F2,... \
#                             [--feedback-file PATH] \
#                             [--limit N] \
#                             [--min-occurrences N]
#
# Defaults:
#   --feedback-file   = $SKILLS_DIR/_shared/integration-feedback.json
#   --limit           = 50    (recent events to scan)
#   --min-occurrences = 2     (ignore one-off conflicts)
#
# Output JSON:
#   {
#     "has_hints": true,
#     "scanned_events": 42,
#     "recurring_files": [
#       {"file": "src/types/user.ts", "occurrences": 3,
#        "lessons": ["..."]}
#     ],
#     "recurring_prefixes": [
#       {"prefix": "src/types", "occurrences": 4}
#     ]
#   }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

AFFECTED_CSV=""
FEEDBACK_FILE=""
LIMIT=50
MIN_OCCURRENCES=2

while [[ $# -gt 0 ]]; do
    case "$1" in
        --affected-files) AFFECTED_CSV="$2"; shift 2 ;;
        --feedback-file) FEEDBACK_FILE="$2"; shift 2 ;;
        --limit) LIMIT="$2"; shift 2 ;;
        --min-occurrences) MIN_OCCURRENCES="$2"; shift 2 ;;
        -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

if [[ -z "$FEEDBACK_FILE" ]]; then
    FEEDBACK_FILE="$SKILLS_DIR/_shared/integration-feedback.json"
fi

[[ "$LIMIT" =~ ^[0-9]+$ ]] || die_json "--limit must be a non-negative integer" 1
[[ "$MIN_OCCURRENCES" =~ ^[0-9]+$ ]] || die_json "--min-occurrences must be a non-negative integer" 1

# Missing/invalid feedback file -> empty hint set (read-only best effort).
if [[ ! -f "$FEEDBACK_FILE" ]] || ! jq empty "$FEEDBACK_FILE" >/dev/null 2>&1; then
    echo '{"has_hints":false,"scanned_events":0,"recurring_files":[],"recurring_prefixes":[]}'
    exit 0
fi

# Convert affected-files CSV into a JSON array. Empty means "no filter".
if [[ -n "$AFFECTED_CSV" ]]; then
    AFFECTED_JSON=$(printf '%s' "$AFFECTED_CSV" | tr ',' '\n' \
        | jq -R 'select(length > 0)' | jq -s '.')
else
    AFFECTED_JSON='[]'
fi

# Recent N events, oldest->newest (tail).
RECENT=$(jq --argjson limit "$LIMIT" \
    '(.events // []) | if $limit > 0 then .[-$limit:] else . end' \
    "$FEEDBACK_FILE")

# Count file occurrences, derive directory prefixes, collect lessons.
jq \
    --argjson affected "$AFFECTED_JSON" \
    --argjson min "$MIN_OCCURRENCES" \
    --argjson events "$RECENT" \
    --null-input \
    '
    def prefix_of($f):
        ($f | split("/")) as $parts
        | if ($parts | length) <= 1 then ""
          else ($parts[0:-1] | join("/")) end;

    ($affected | length > 0) as $has_filter |

    # File -> occurrence count & lessons
    ($events
     | map(. as $ev
           | (.files // [])
           | map({file: ., lesson: ($ev.lesson // "")}))
     | add // []
     | group_by(.file)
     | map({
         file: .[0].file,
         occurrences: length,
         lessons: [.[] | select(.lesson != "") | .lesson] | unique
       })
     | map(select(.occurrences >= $min))
     | map(select(
         ($has_filter | not)
         or ((.file) as $f | ($affected | index($f)) != null)
       ))
     | sort_by(-.occurrences)
    ) as $files_hot |

    # Prefix -> occurrence count
    ($events
     | map((.files // []) | map(prefix_of(.)) | map(select(. != "")))
     | add // []
     | group_by(.)
     | map({prefix: .[0], occurrences: length})
     | map(select(.occurrences >= $min))
     | map(select(
         ($has_filter | not)
         or ((.prefix) as $p | $affected | any(. as $a | $a | startswith($p + "/")))
       ))
     | sort_by(-.occurrences)
    ) as $prefix_hot |

    {
      has_hints: (($files_hot | length > 0) or ($prefix_hot | length > 0)),
      scanned_events: ($events | length),
      recurring_files: $files_hot,
      recurring_prefixes: $prefix_hot
    }
    '
