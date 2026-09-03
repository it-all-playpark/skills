#!/usr/bin/env bash
# load-config.sh - Load sns-announce configuration
# Usage: load-config.sh [project-root]
#
# Searches for .claude/sns-announce.json in project root
# Output: JSON config or default config if not found

set -euo pipefail

# Load shared config utilities
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

PROJECT_ROOT="${1:-.}"

# Resolve to absolute path
PROJECT_ROOT=$(cd "$PROJECT_ROOT" 2>/dev/null && pwd || echo "$PROJECT_ROOT")

# Default configuration
DEFAULT_CONFIG='{
  "base_url": null,
  "url_pattern": null,
  "default_lang": "ja",
  "platforms": {
    "x": { "enabled": true, "char_limit": 280 },
    "linkedin": { "enabled": true, "char_limit": 1300 },
    "google": { "enabled": true, "char_limit": 1500 }
  },
  "templates_dir": null
}'

# Load config: skill-config.json > legacy sns-announce.json > defaults
SKILL_CONFIG=$(load_skill_config "sns-announce")

if [[ "$SKILL_CONFIG" != "{}" ]]; then
    # Merge defaults with skill config
    if command -v jq &> /dev/null; then
        echo "$DEFAULT_CONFIG" | jq --argjson user "$SKILL_CONFIG" '. * $user + {_config_source: "skill-config.json", _found: true}'
    else
        echo "$SKILL_CONFIG"
    fi
else
    # Return defaults with metadata
    if command -v jq &> /dev/null; then
        echo "$DEFAULT_CONFIG" | jq '. + {_config_source: null, _found: false}'
    else
        echo "$DEFAULT_CONFIG"
    fi
fi
