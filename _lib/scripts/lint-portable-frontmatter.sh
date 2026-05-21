#!/usr/bin/env bash
# lint-portable-frontmatter.sh — invariant lint for SKILL.md portable subset compliance.
#
# Scans SKILL.md files under <root> and reports which Claude Code 拡張 frontmatter
# fields are present. Output is machine-readable JSON (--json) or a human summary
# (default). In --strict mode, exits non-zero if any non-portable field is present
# so CI can enforce migration progress (see issue #103).
#
# Portable subset (SKILL.md open spec, Linux Foundation AAIF 2025-12):
#   name, description, version, author, tags, agents, license, metadata
#
# Claude Code 拡張 (not portable):
#   allowed-tools, model, effort, context, agent, hooks,
#   disable-model-invocation, user-invocable, argument-hint, arguments,
#   paths, shell
#
# Usage:
#   lint-portable-frontmatter.sh --root <dir> [--json] [--strict]
#
# Exit:
#   0  lint succeeded (default mode) OR strict mode + all portable
#   1  usage / argument error
#   2  strict mode + at least one ext field present

set -euo pipefail

usage() {
  cat >&2 <<EOF
usage: $0 --root <dir> [--json] [--strict]

  --root <dir>   directory to scan recursively for SKILL.md (required)
  --json         emit JSON summary instead of human-readable text
  --strict       exit 2 if any 拡張 frontmatter field is present
  --help         print this help and exit 1

Portable subset (8 fields):
  name, description, version, author, tags, agents, license, metadata

Claude Code 拡張 (12 fields, excluded from portable subset):
  allowed-tools, model, effort, context, agent, hooks,
  disable-model-invocation, user-invocable, argument-hint, arguments,
  paths, shell
EOF
  exit 1
}

ROOT=""
JSON_OUT=false
STRICT=false

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --json) JSON_OUT=true; shift ;;
    --strict) STRICT=true; shift ;;
    --help|-h) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -z "$ROOT" ] && usage
[ -d "$ROOT" ] || { echo "root does not exist: $ROOT" >&2; exit 1; }

# Claude Code 拡張 frontmatter fields (kept in script-stable order for JSON output).
EXT_FIELDS=(
  "allowed-tools"
  "model"
  "effort"
  "context"
  "agent"
  "hooks"
  "disable-model-invocation"
  "user-invocable"
  "argument-hint"
  "arguments"
  "paths"
  "shell"
)

# Discover SKILL.md files. Exclude:
#   - .agents/ (upstream skill symlinks)
#   - .git/, node_modules/, claudedocs/
#   - .claude/worktrees/ (nested worktree copies of this repo)
mapfile -t SKILL_FILES < <(
  find "$ROOT" \
    -type d \( -name '.git' -o -name 'node_modules' -o -name 'claudedocs' \
            -o -name '.agents' -o -name 'worktrees' \) -prune -o \
    -type f -name 'SKILL.md' -print 2>/dev/null \
  | sort -u
)

SCANNED=${#SKILL_FILES[@]}

# Initialize per-field counts.
declare -A FIELD_COUNT
for f in "${EXT_FIELDS[@]}"; do FIELD_COUNT[$f]=0; done

FILES_WITH_EXT=0

audit_one() {
  local file="$1"
  local frontmatter
  frontmatter=$(awk '/^---[[:space:]]*$/{c++; if(c==2)exit; next} c==1' "$file" 2>/dev/null || true)
  [ -z "$frontmatter" ] && return 0

  local has_any=false
  for field in "${EXT_FIELDS[@]}"; do
    if printf '%s\n' "$frontmatter" | grep -qE "^${field}:"; then
      FIELD_COUNT[$field]=$(( FIELD_COUNT[$field] + 1 ))
      has_any=true
    fi
  done
  if [ "$has_any" = true ]; then
    FILES_WITH_EXT=$(( FILES_WITH_EXT + 1 ))
  fi
}

for skill in "${SKILL_FILES[@]}"; do
  audit_one "$skill"
done

# Emit output.
if [ "$JSON_OUT" = true ]; then
  # Build ext_field_usage JSON object with all fields (even zero counts) for stability.
  ext_usage="{"
  first=true
  for field in "${EXT_FIELDS[@]}"; do
    if [ "$first" = true ]; then first=false; else ext_usage+=","; fi
    ext_usage+="\n    \"$field\": ${FIELD_COUNT[$field]}"
  done
  ext_usage+="\n  }"

  printf '{\n  "scanned": %d,\n  "ext_field_usage": %s,\n  "files_with_ext_fields": %d\n}\n' \
    "$SCANNED" "$(printf '%b' "$ext_usage")" "$FILES_WITH_EXT"
else
  echo "[lint-portable-frontmatter] scanned: $SCANNED SKILL.md files under $ROOT"
  echo ""
  echo "ext_field_usage:"
  for field in "${EXT_FIELDS[@]}"; do
    if [ "${FIELD_COUNT[$field]}" -gt 0 ]; then
      printf "  %-28s %d\n" "$field" "${FIELD_COUNT[$field]}"
    fi
  done
  echo ""
  echo "files_with_ext_fields: $FILES_WITH_EXT / $SCANNED"
fi

# Strict mode: fail if any ext field is present.
if [ "$STRICT" = true ] && [ "$FILES_WITH_EXT" -gt 0 ]; then
  echo "" >&2
  echo "[lint-portable-frontmatter] strict mode: $FILES_WITH_EXT file(s) use non-portable frontmatter fields" >&2
  exit 2
fi

exit 0
