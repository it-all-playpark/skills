#!/usr/bin/env bash
# validate-skill-frontmatter.sh - PreToolUse Hook for SKILL.md frontmatter validation
#
# Reads PreToolUse JSON from stdin. Blocks Write if SKILL.md frontmatter is invalid.
#
# Validation rules:
#   - name: required
#   - description: required, max 500 chars
#   - model: if present, must be haiku|sonnet|opus
#   - effort: if present, must be low|medium|high|xhigh|max
#   - context: if present, must be fork

set -euo pipefail

INPUT=$(cat)

CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null) || exit 0
[[ -z $CONTENT ]] && exit 0

# Extract frontmatter (between first pair of ---)
FRONTMATTER=$(echo "$CONTENT" | sed -n '/^---$/,/^---$/p' | sed '1d;$d')
[[ -z $FRONTMATTER ]] && exit 0

ERRORS=()

# --- Required fields ---

NAME=$(echo "$FRONTMATTER" | grep -E '^name:\s*' | head -1 | sed 's/^name:\s*//' | xargs 2>/dev/null || true)
if [[ -z $NAME ]]; then
  ERRORS+=("Missing required field: name")
fi

if ! echo "$FRONTMATTER" | grep -qE '^description:'; then
  ERRORS+=("Missing required field: description")
else
  DESC_LINE=$(echo "$FRONTMATTER" | grep -E '^description:' | head -1)
  DESC_INLINE=$(echo "$DESC_LINE" | sed 's/^description:\s*//')

  if [[ $DESC_INLINE == "|" || $DESC_INLINE == ">" || -z $DESC_INLINE ]]; then
    DESC_VALUE=$(echo "$FRONTMATTER" | sed -n '/^description:/,/^[a-z]/{/^description:/d;/^[a-z]/d;p;}' | sed 's/^  //')
  else
    DESC_VALUE="$DESC_INLINE"
  fi

  DESC_LEN=${#DESC_VALUE}
  if [[ $DESC_LEN -gt 500 ]]; then
    ERRORS+=("description exceeds 500 character limit (current: ${DESC_LEN} chars)")
  fi

  TRIMMED_DESC=$(echo "$DESC_VALUE" | xargs 2>/dev/null || true)
  if [[ -z $TRIMMED_DESC ]]; then
    ERRORS+=("description is empty")
  fi
fi

# --- Optional field validation ---

MODEL=$(echo "$FRONTMATTER" | grep -E '^model:\s*' | head -1 | sed 's/^model:\s*//' | xargs 2>/dev/null || true)
if [[ -n $MODEL ]]; then
  case "$MODEL" in
  haiku | sonnet | opus) ;;
  *) ERRORS+=("Invalid model: '${MODEL}'. Must be one of: haiku, sonnet, opus") ;;
  esac
fi

EFFORT=$(echo "$FRONTMATTER" | grep -E '^effort:\s*' | head -1 | sed 's/^effort:\s*//' | xargs 2>/dev/null || true)
if [[ -n $EFFORT ]]; then
  case "$EFFORT" in
  low | medium | high | xhigh | max) ;;
  *) ERRORS+=("Invalid effort: '${EFFORT}'. Must be one of: low, medium, high, xhigh, max") ;;
  esac
fi

CONTEXT=$(echo "$FRONTMATTER" | grep -E '^context:\s*' | head -1 | sed 's/^context:\s*//' | xargs 2>/dev/null || true)
if [[ -n $CONTEXT ]]; then
  case "$CONTEXT" in
  fork) ;;
  *) ERRORS+=("Invalid context: '${CONTEXT}'. Must be: fork") ;;
  esac
fi

# --- Output ---

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  REASON=""
  for err in "${ERRORS[@]}"; do
    [[ -n $REASON ]] && REASON+="; "
    REASON+="$err"
  done

  jq -n --arg reason "SKILL.md frontmatter validation failed: $REASON" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$reason}}'
fi
