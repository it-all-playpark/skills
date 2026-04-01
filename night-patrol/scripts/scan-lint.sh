#!/usr/bin/env bash
# scan-lint.sh - Scan for lint errors, type errors, TODOs, and vulnerabilities
# Usage: scan-lint.sh [--dir PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TARGET_DIR="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
cd "$TARGET_DIR"

require_git_repo

# ============================================================================
# Findings accumulator
# ============================================================================

FINDINGS=()

add_finding() {
  FINDINGS+=("$1")
}

# ============================================================================
# Node.js checks
# ============================================================================

scan_nodejs() {
  local pkg="$TARGET_DIR/package.json"
  [[ -f "$pkg" ]] || return 0

  # TypeScript type check
  if [[ -f "$TARGET_DIR/tsconfig.json" ]]; then
    local tsc_out
    tsc_out=$(npx tsc --noEmit 2>&1) || true
    if [[ -n "$tsc_out" ]]; then
      while IFS= read -r line; do
        # Parse lines like: src/foo.ts(42,5): error TS2322: Type '...'
        if [[ "$line" =~ ^(.+)\(([0-9]+),[0-9]+\):\ error\ (TS[0-9]+):\ (.+)$ ]]; then
          local file="${BASH_REMATCH[1]}"
          local lineno="${BASH_REMATCH[2]}"
          local rule="${BASH_REMATCH[3]}"
          local msg="${BASH_REMATCH[4]}"
          add_finding "{\"type\":\"type_error\",\"file\":$(json_str "$file"),\"line\":$lineno,\"message\":$(json_str "$msg"),\"rule\":$(json_str "$rule")}"
        fi
      done <<< "$tsc_out"
    fi
  fi

  # ESLint check
  local has_eslint=false
  if has_jq; then
    has_eslint=$(jq -r '
      ((.dependencies // {}) + (.devDependencies // {})) |
      if has("eslint") then "true" else "false" end
    ' "$pkg" 2>/dev/null) || true
  else
    grep -q '"eslint"' "$pkg" 2>/dev/null && has_eslint=true || true
  fi

  if [[ "$has_eslint" == "true" ]]; then
    local eslint_out
    eslint_out=$(npx eslint . --format json 2>/dev/null) || true
    if [[ -n "$eslint_out" ]] && has_jq; then
      while IFS= read -r finding; do
        [[ -n "$finding" ]] && add_finding "$finding"
      done < <(echo "$eslint_out" | jq -c '
        .[] |
        .filePath as $file |
        .messages[] |
        {
          type: "lint_error",
          file: ($file | gsub(".*?(?=[^/]+/[^/]+$)"; "")),
          line: .line,
          message: .message,
          rule: (.ruleId // "unknown")
        }
      ' 2>/dev/null || true)
    fi
  fi

  # npm audit (critical/high only)
  local audit_out
  audit_out=$(npm audit --json 2>/dev/null) || true
  if [[ -n "$audit_out" ]] && has_jq; then
    while IFS= read -r finding; do
      [[ -n "$finding" ]] && add_finding "$finding"
    done < <(echo "$audit_out" | jq -c '
      (.vulnerabilities // {}) |
      to_entries[] |
      select(.value.severity == "critical" or .value.severity == "high") |
      {
        type: "vulnerability",
        package: .key,
        severity: .value.severity,
        message: (.value.via[0] | if type == "string" then . else (.title // "vulnerability") end)
      }
    ' 2>/dev/null || true)
  fi
}

# ============================================================================
# Rust checks
# ============================================================================

scan_rust() {
  [[ -f "$TARGET_DIR/Cargo.toml" ]] || return 0
  command -v cargo &>/dev/null || return 0

  local clippy_out
  clippy_out=$(cargo clippy --message-format=json 2>/dev/null) || true
  if [[ -n "$clippy_out" ]] && has_jq; then
    while IFS= read -r finding; do
      [[ -n "$finding" ]] && add_finding "$finding"
    done < <(echo "$clippy_out" | jq -c '
      select(.reason == "compiler-message") |
      select(.message.level == "error" or .message.level == "warning") |
      {
        type: "lint_error",
        file: (.message.spans[0].file_name // "unknown"),
        line: (.message.spans[0].line_start // 0),
        message: .message.message,
        rule: (.message.code.code // "clippy")
      }
    ' 2>/dev/null || true)
  fi
}

# ============================================================================
# Go checks
# ============================================================================

scan_go() {
  [[ -f "$TARGET_DIR/go.mod" ]] || return 0
  command -v go &>/dev/null || return 0

  local vet_out
  vet_out=$(go vet ./... 2>&1) || true
  if [[ -n "$vet_out" ]]; then
    while IFS= read -r line; do
      # Parse lines like: ./foo/bar.go:42:5: message
      if [[ "$line" =~ ^(.+\.go):([0-9]+):[0-9]+:\ (.+)$ ]]; then
        local file="${BASH_REMATCH[1]}"
        local lineno="${BASH_REMATCH[2]}"
        local msg="${BASH_REMATCH[3]}"
        add_finding "{\"type\":\"lint_error\",\"file\":$(json_str "$file"),\"line\":$lineno,\"message\":$(json_str "$msg"),\"rule\":\"go-vet\"}"
      fi
    done <<< "$vet_out"
  fi
}

# ============================================================================
# Python checks
# ============================================================================

scan_python() {
  # Detect Python project
  local has_python=false
  [[ -f "$TARGET_DIR/pyproject.toml" ]] && has_python=true
  [[ -f "$TARGET_DIR/setup.py" ]] && has_python=true
  [[ -f "$TARGET_DIR/requirements.txt" ]] && has_python=true
  [[ "$has_python" == "false" ]] && return 0

  local lint_out=""

  if command -v ruff &>/dev/null; then
    lint_out=$(ruff check . --output-format=json 2>/dev/null) || true
    if [[ -n "$lint_out" ]] && has_jq; then
      while IFS= read -r finding; do
        [[ -n "$finding" ]] && add_finding "$finding"
      done < <(echo "$lint_out" | jq -c '
        .[] |
        {
          type: "lint_error",
          file: .filename,
          line: .location.row,
          message: .message,
          rule: .code
        }
      ' 2>/dev/null || true)
    fi
  elif command -v flake8 &>/dev/null; then
    lint_out=$(flake8 . --format=default 2>/dev/null) || true
    if [[ -n "$lint_out" ]]; then
      while IFS= read -r line; do
        # Parse: ./foo.py:42:5: E302 message
        if [[ "$line" =~ ^(.+\.py):([0-9]+):[0-9]+:\ ([A-Z][0-9]+)\ (.+)$ ]]; then
          local file="${BASH_REMATCH[1]}"
          local lineno="${BASH_REMATCH[2]}"
          local rule="${BASH_REMATCH[3]}"
          local msg="${BASH_REMATCH[4]}"
          add_finding "{\"type\":\"lint_error\",\"file\":$(json_str "$file"),\"line\":$lineno,\"message\":$(json_str "$msg"),\"rule\":$(json_str "$rule")}"
        fi
      done <<< "$lint_out"
    fi
  fi
}

# ============================================================================
# TODO/FIXME/HACK/XXX scan
# ============================================================================

scan_todos() {
  local search_dirs=()
  for d in src app lib; do
    [[ -d "$TARGET_DIR/$d" ]] && search_dirs+=("$TARGET_DIR/$d")
  done
  [[ ${#search_dirs[@]} -eq 0 ]] && return 0

  local count=0
  while IFS= read -r line && [[ $count -lt 30 ]]; do
    # grep output: file:lineno:content
    if [[ "$line" =~ ^(.+):([0-9]+):(.+)$ ]]; then
      local file="${BASH_REMATCH[1]}"
      local lineno="${BASH_REMATCH[2]}"
      local msg="${BASH_REMATCH[3]}"
      # Strip leading whitespace from message
      msg="${msg#"${msg%%[![:space:]]*}"}"
      add_finding "{\"type\":\"todo\",\"file\":$(json_str "$file"),\"line\":$lineno,\"message\":$(json_str "$msg")}"
      (( count++ )) || true
    fi
  done < <(grep -rn \
    --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" \
    --include="*.py" --include="*.go" --include="*.rs" --include="*.rb" \
    --include="*.java" --include="*.kt" --include="*.swift" --include="*.sh" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build \
    -E "TODO|FIXME|HACK|XXX" \
    "${search_dirs[@]}" 2>/dev/null || true)
}

# ============================================================================
# Main
# ============================================================================

scan_nodejs
scan_rust
scan_go
scan_python
scan_todos

# Output JSON array
if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  echo "[]"
else
  echo "["
  for i in "${!FINDINGS[@]}"; do
    if [[ $i -lt $(( ${#FINDINGS[@]} - 1 )) ]]; then
      echo "  ${FINDINGS[$i]},"
    else
      echo "  ${FINDINGS[$i]}"
    fi
  done
  echo "]"
fi
