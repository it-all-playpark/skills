#!/usr/bin/env bash
# load-config.sh - Load video-announce configuration with defaults
#
# Usage: load-config.sh
# Output: Merged config JSON (defaults * skill-config)

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmd jq

DEFAULT_CONFIG='{
  "default_lang": "ja",
  "output": {
    "dir": "post",
    "pattern": "{date}-{slug}.json",
    "format": "json"
  },
  "platforms": {
    "instagram": { "enabled": true },
    "youtube": { "enabled": true },
    "tiktok": { "enabled": true }
  },
  "brand": {
    "always_tags": []
  },
  "platformDefaults": {
    "thumbOffset": null
  },
  "schedule": {
    "enabled": true,
    "mode": "auto"
  }
}'

MERGED=$(merge_config "$DEFAULT_CONFIG" "video-announce")

echo "$MERGED"
