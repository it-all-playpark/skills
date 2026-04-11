#!/usr/bin/env bash
# check-unacked-findings.sh - Warn about shared_findings not acked by all subtasks.
# Used by dev-integrate before merging subtask branches.
#
# Always exits 0 (warning, not an error). Downstream callers decide what to do
# with the report.
#
# Usage:
#   check-unacked-findings.sh --flow-state PATH
#
# Output JSON:
#   {
#     "unacked_count": N,
#     "unacked": [
#       {"id": "sf_001", "title": "...", "task_id": "task1",
#        "category": "breaking_change", "missing_ack": ["task2","task3"]}
#     ]
#   }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FLOW_STATE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help) sed -n '1,25p' "$0"; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "--flow-state required" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

jq '
def all_task_ids: [.subtasks[].id];

(.shared_findings // []) as $findings
| all_task_ids as $tasks
| [
    $findings[]
    | . as $f
    | ($tasks
        | map(select(. != $f.task_id and (($f.acknowledged_by // []) | index(.) | not)))
      ) as $missing
    | select(($missing | length) > 0)
    | {
        id: .id,
        title: .title,
        task_id: .task_id,
        category: .category,
        missing_ack: $missing
      }
  ] as $unacked
| {
    unacked_count: ($unacked | length),
    unacked: $unacked
  }
' "$FLOW_STATE"
