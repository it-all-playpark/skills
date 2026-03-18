#!/usr/bin/env bash
# load-config.sh - Load meeting-followup configuration
# Usage: load-config.sh [--scheduling-url URL] [--document-url URL] [--meeting-url URL]
# Output: Merged config JSON (defaults → skill-config.json → CLI overrides)

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmd jq

# ============================================================================
# Defaults
# ============================================================================

DEFAULT_CONFIG='{
  "defaults": {
    "scheduling_url": null,
    "document_url": null,
    "meeting_url": null,
    "sender_name": null,
    "company_name": null
  },
  "email_template": {
    "subject": null,
    "closing": null
  },
  "minutes": {
    "output_dir": "claudedocs/minutes"
  }
}'

# ============================================================================
# Parse CLI overrides
# ============================================================================

CLI_OVERRIDES="{}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scheduling-url)
      CLI_OVERRIDES=$(echo "$CLI_OVERRIDES" | jq --arg v "$2" '.defaults.scheduling_url = $v')
      shift 2
      ;;
    --document-url)
      CLI_OVERRIDES=$(echo "$CLI_OVERRIDES" | jq --arg v "$2" '.defaults.document_url = $v')
      shift 2
      ;;
    --meeting-url)
      CLI_OVERRIDES=$(echo "$CLI_OVERRIDES" | jq --arg v "$2" '.defaults.meeting_url = $v')
      shift 2
      ;;
    *)
      die_json "Unknown option: $1"
      ;;
  esac
done

# ============================================================================
# Merge: defaults → skill-config.json → CLI overrides
# ============================================================================

MERGED=$(merge_config "$DEFAULT_CONFIG" "meeting-followup")

if [[ "$CLI_OVERRIDES" != "{}" ]]; then
  MERGED=$(echo "$MERGED" | jq --argjson cli "$CLI_OVERRIDES" '. * $cli')
fi

echo "$MERGED"
