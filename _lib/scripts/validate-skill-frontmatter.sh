#!/usr/bin/env bash
# validate-skill-frontmatter.sh - PreToolUse Hook for SKILL.md frontmatter validation
#
# Reads PreToolUse JSON from stdin. Blocks Write if SKILL.md frontmatter is invalid.
# Output: {"decision":"block","reason":"..."} on failure, empty on success (implicit approve).
#
# Validation rules:
#   - name: required
#   - description: required, max 500 chars
#   - model: if present, must be haiku|sonnet|opus
#   - effort: if present, must be low|medium|high
#   - context: if present, must be fork

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract tool_input fields
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null) || exit 0

# Only validate SKILL.md files
case "$FILE_PATH" in
  */SKILL.md) ;;
  *) exit 0 ;;
esac

# Skip if content is empty
[[ -z "$CONTENT" ]] && exit 0

# Extract frontmatter (between first pair of ---)
FRONTMATTER=$(echo "$CONTENT" | sed -n '/^---$/,/^---$/p' | sed '1d;$d')

# Skip if no frontmatter found
[[ -z "$FRONTMATTER" ]] && exit 0

ERRORS=()

# --- Required field checks ---

# Check 'name' exists and is non-empty
NAME=$(echo "$FRONTMATTER" | grep -E '^name:\s*' | head -1 | sed 's/^name:\s*//' | xargs 2>/dev/null || true)
if [[ -z "$NAME" ]]; then
  ERRORS+=("Missing required field: name")
fi

# Check 'description' exists
# description can be multi-line (block scalar with |), so check the key exists
if ! echo "$FRONTMATTER" | grep -qE '^description:'; then
  ERRORS+=("Missing required field: description")
else
  # Extract description value for length check
  # Handle both inline and block scalar (|) formats
  DESC_LINE=$(echo "$FRONTMATTER" | grep -E '^description:' | head -1)
  DESC_INLINE=$(echo "$DESC_LINE" | sed 's/^description:\s*//')

  if [[ "$DESC_INLINE" == "|" || "$DESC_INLINE" == ">" || -z "$DESC_INLINE" ]]; then
    # Block scalar: extract indented lines after 'description:'
    DESC_VALUE=$(echo "$FRONTMATTER" | sed -n '/^description:/,/^[a-z]/{/^description:/d;/^[a-z]/d;p;}' | sed 's/^  //')
  else
    DESC_VALUE="$DESC_INLINE"
  fi

  # Check description length (character count)
  DESC_LEN=${#DESC_VALUE}
  if [[ $DESC_LEN -gt 500 ]]; then
    ERRORS+=("description exceeds 500 character limit (current: ${DESC_LEN} chars)")
  fi

  # Check description is not empty
  TRIMMED_DESC=$(echo "$DESC_VALUE" | xargs 2>/dev/null || true)
  if [[ -z "$TRIMMED_DESC" ]]; then
    ERRORS+=("description is empty")
  fi
fi

# --- Optional field value validation ---

# Validate 'model' if present
MODEL=$(echo "$FRONTMATTER" | grep -E '^model:\s*' | head -1 | sed 's/^model:\s*//' | xargs 2>/dev/null || true)
if [[ -n "$MODEL" ]]; then
  case "$MODEL" in
    haiku|sonnet|opus) ;;
    *) ERRORS+=("Invalid model: '${MODEL}'. Must be one of: haiku, sonnet, opus") ;;
  esac
fi

# Validate 'effort' if present
EFFORT=$(echo "$FRONTMATTER" | grep -E '^effort:\s*' | head -1 | sed 's/^effort:\s*//' | xargs 2>/dev/null || true)
if [[ -n "$EFFORT" ]]; then
  case "$EFFORT" in
    low|medium|high) ;;
    *) ERRORS+=("Invalid effort: '${EFFORT}'. Must be one of: low, medium, high") ;;
  esac
fi

# Validate 'context' if present
CONTEXT=$(echo "$FRONTMATTER" | grep -E '^context:\s*' | head -1 | sed 's/^context:\s*//' | xargs 2>/dev/null || true)
if [[ -n "$CONTEXT" ]]; then
  case "$CONTEXT" in
    fork) ;;
    *) ERRORS+=("Invalid context: '${CONTEXT}'. Must be: fork") ;;
  esac
fi

# --- Output result ---

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  # Join errors with "; "
  REASON=""
  for err in "${ERRORS[@]}"; do
    [[ -n "$REASON" ]] && REASON+="; "
    REASON+="$err"
  done

  # Output block decision
  jq -n --arg reason "SKILL.md frontmatter validation failed: $REASON" \
    '{"decision":"block","reason":$reason}'
fi
