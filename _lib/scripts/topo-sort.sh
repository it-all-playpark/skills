#!/usr/bin/env bash
# topo-sort.sh - Topological sort of subtasks by depends_on (Kahn's algorithm)
# Usage: topo-sort.sh --flow-state PATH
#
# Input: flow.json with subtasks[].depends_on
# Output: JSON array of subtask objects in dependency order (leaves first)
# Exit 1 if circular dependency detected.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: topo-sort.sh --flow-state PATH"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "flow.json path required (--flow-state)" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

RESULT=$(jq -c '
  [.subtasks[] | {id: .id, branch: (.branch // ""), scope: (.scope // ""), files: (.files // []), depends_on: (.depends_on // []), status: (.status // "pending")}] |
  # Kahn algorithm for topological sort
  . as $tasks |
  (reduce .[] as $t (
    {};
    . as $deg | reduce $t.depends_on[] as $dep ($deg; .[$dep] = (.[$dep] // 0))
    | .[$t.id] = (.[$t.id] // 0) + ($t.depends_on | length)
  )) as $in_degree_raw |
  (reduce $tasks[] as $t ($in_degree_raw; .[$t.id] = (.[$t.id] // 0))) as $in_degree |
  [$tasks[] | select($in_degree[.id] == 0)] as $queue |
  {result: [], queue: $queue, in_degree: $in_degree, tasks: $tasks} |
  until(.queue | length == 0;
    .queue[0] as $current |
    .result += [$current] |
    .queue = .queue[1:] |
    (reduce ($tasks[] | select(.depends_on | index($current.id))) as $dep (
      {in_degree: .in_degree, new_queue: []};
      .in_degree[$dep.id] = (.in_degree[$dep.id] - 1) |
      if .in_degree[$dep.id] == 0 then .new_queue += [$dep] else . end
    )) as $update |
    .in_degree = $update.in_degree |
    .queue += $update.new_queue
  ) |
  if (.result | length) < ($tasks | length) then
    error("Circular dependency detected")
  else
    .result
  end
' "$FLOW_STATE")

echo "$RESULT"
