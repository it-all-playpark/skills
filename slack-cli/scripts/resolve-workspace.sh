#!/usr/bin/env bash
set -euo pipefail

# resolve-workspace.sh - Resolve Slack workspace token from config
# Usage: resolve-workspace.sh [--workspace NAME]
# Output: JSON with resolved token env var name and team_id

source "$(dirname "$0")/../../_lib/common.sh"

# ============================================================================
# Defaults & Args
# ============================================================================

WORKSPACE_NAME=""
CONFIG_FILE="${HOME}/.claude/skills/slack-cli/workspaces.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: resolve-workspace.sh [--workspace NAME]"
      echo "Resolve Slack workspace token from workspaces.json config."
      exit 0
      ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

# ============================================================================
# Config file check
# ============================================================================

if [[ ! -f "$CONFIG_FILE" ]]; then
  # Fallback: no config file, assume SLACK_BOT_TOKEN
  token_env="SLACK_BOT_TOKEN"
  token_set=false
  [[ -n "${!token_env:-}" ]] && token_set=true

  if has_jq; then
    jq -n \
      --arg ws "fallback" \
      --arg te "$token_env" \
      --argjson ts "$token_set" \
      '{workspace: $ws, token_env: $te, team_id: null, token_set: $ts}'
  else
    echo "{\"workspace\":\"fallback\",\"token_env\":\"$token_env\",\"team_id\":null,\"token_set\":$token_set}"
  fi
  exit 0
fi

require_cmd "jq" "jq is required for workspace resolution"

# ============================================================================
# Resolve workspace name
# ============================================================================

if [[ -z "$WORKSPACE_NAME" ]]; then
  # Use default field
  WORKSPACE_NAME=$(jq -r '.default // empty' "$CONFIG_FILE" 2>/dev/null || true)
  if [[ -z "$WORKSPACE_NAME" || "$WORKSPACE_NAME" == "null" ]]; then
    # No default set, fallback to SLACK_BOT_TOKEN
    token_env="SLACK_BOT_TOKEN"
    token_set=false
    [[ -n "${!token_env:-}" ]] && token_set=true
    jq -n \
      --arg ws "fallback" \
      --arg te "$token_env" \
      --argjson ts "$token_set" \
      '{workspace: $ws, token_env: $te, team_id: null, token_set: $ts}'
    exit 0
  fi
fi

# ============================================================================
# Look up workspace entry
# ============================================================================

workspace_entry=$(jq -r --arg name "$WORKSPACE_NAME" '.workspaces[$name] // empty' "$CONFIG_FILE" 2>/dev/null || true)

if [[ -z "$workspace_entry" ]]; then
  die_json "Workspace '$WORKSPACE_NAME' not found in $CONFIG_FILE" 1
fi

token_env=$(echo "$workspace_entry" | jq -r '.token_env // empty')
team_id=$(echo "$workspace_entry" | jq -r '.team_id // empty')

if [[ -z "$token_env" ]]; then
  die_json "No token_env defined for workspace '$WORKSPACE_NAME'" 1
fi

# ============================================================================
# Verify env var is set (don't output the value)
# ============================================================================

token_set=false
if [[ -n "${!token_env:-}" ]]; then
  token_set=true
fi

# ============================================================================
# Output
# ============================================================================

team_id_json="null"
if [[ -n "$team_id" && "$team_id" != "null" ]]; then
  team_id_json=$(json_str "$team_id")
fi

jq -n \
  --arg ws "$WORKSPACE_NAME" \
  --arg te "$token_env" \
  --argjson tid "$team_id_json" \
  --argjson ts "$token_set" \
  '{workspace: $ws, token_env: $te, team_id: $tid, token_set: $ts}'
