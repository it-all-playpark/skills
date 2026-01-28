#!/usr/bin/env bash
# load-config.sh - Load sns-announce configuration
# Usage: load-config.sh [project-root]
#
# Searches for .claude/sns-announce.json in project root
# Output: JSON config or default config if not found

set -euo pipefail

PROJECT_ROOT="${1:-.}"

# Resolve to absolute path
PROJECT_ROOT=$(cd "$PROJECT_ROOT" 2>/dev/null && pwd || echo "$PROJECT_ROOT")

CONFIG_PATH="$PROJECT_ROOT/.claude/sns-announce.json"

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

if [[ -f "$CONFIG_PATH" ]]; then
    # Merge user config with defaults (user values override defaults)
    USER_CONFIG=$(cat "$CONFIG_PATH")
    
    # Use jq to merge if available, otherwise just return user config
    if command -v jq &> /dev/null; then
        echo "$DEFAULT_CONFIG" | jq --argjson user "$USER_CONFIG" '. * $user + {_config_path: "'"$CONFIG_PATH"'", _found: true}'
    else
        echo "$USER_CONFIG"
    fi
else
    # Return defaults with metadata
    if command -v jq &> /dev/null; then
        echo "$DEFAULT_CONFIG" | jq '. + {_config_path: null, _found: false}'
    else
        echo "$DEFAULT_CONFIG"
    fi
fi
