#!/usr/bin/env bash
# AC1 (v2 / issue #93): _lib/scripts/validate-decomposition.sh が v2 schema
# (integration_branch / children / batches) を validate することを確認。
# v1 (subtasks / contract / shared_findings) は schema error として reject されること。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/_lib/scripts/validate-decomposition.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

validate_json() {
    jq empty "$1" 2>/dev/null || fail "Fixture is not valid JSON: $1"
}

# --- Fixture 1: minimal valid v2 flow.json ---
cat > "$TMP_DIR/v2-valid.json" <<'JSON'
{
  "version": "2.0.0",
  "issue": 1,
  "status": "decomposing",
  "integration_branch": {
    "name": "integration/issue-1-foo",
    "base": "main",
    "created_at": "2026-05-15T00:00:00Z"
  },
  "children": [
    {"issue": 101, "slug": "scope-a", "scope": "scope a description", "status": "pending"},
    {"issue": 102, "slug": "scope-b", "scope": "scope b description", "status": "pending"}
  ],
  "batches": [
    {"batch": 1, "mode": "serial", "children": [101]},
    {"batch": 2, "mode": "parallel", "children": [102]}
  ],
  "config": {"base_branch": "main"}
}
JSON
validate_json "$TMP_DIR/v2-valid.json"

# --- Fixture 2: legacy v1 (subtasks) → must be rejected ---
cat > "$TMP_DIR/v1-legacy.json" <<'JSON'
{
  "version": "1.0.0",
  "issue": 1,
  "status": "decomposing",
  "subtasks": [
    {"id": "task1", "scope": "x", "files": ["a.ts"], "branch": "feature/issue-1-task1", "status": "pending", "checklist": []}
  ],
  "config": {"base_branch": "main"}
}
JSON
validate_json "$TMP_DIR/v1-legacy.json"

# --- Fixture 3: missing required v2 field (children) ---
cat > "$TMP_DIR/v2-missing-children.json" <<'JSON'
{
  "version": "2.0.0",
  "issue": 1,
  "status": "decomposing",
  "integration_branch": {
    "name": "integration/issue-1-foo",
    "base": "main",
    "created_at": "2026-05-15T00:00:00Z"
  },
  "batches": [
    {"batch": 1, "mode": "serial", "children": [101]}
  ],
  "config": {"base_branch": "main"}
}
JSON
validate_json "$TMP_DIR/v2-missing-children.json"

# Case 1: v2 valid fixture → accepted
if [[ -x "$SCRIPT" ]]; then
    "$SCRIPT" --flow-state "$TMP_DIR/v2-valid.json" >/dev/null 2>&1 \
        || fail "Case 1: v2 valid fixture should be accepted (got non-zero exit)"
    pass "Case 1: v2 valid flow.json accepted"
else
    fail "Case 1: $SCRIPT not executable or missing"
fi

# Case 2: v1 legacy → rejected
if "$SCRIPT" --flow-state "$TMP_DIR/v1-legacy.json" >/dev/null 2>&1; then
    fail "Case 2: v1 legacy fixture should be rejected (no-backcompat)"
fi
pass "Case 2: v1 legacy schema rejected"

# Case 3: missing children → rejected
if "$SCRIPT" --flow-state "$TMP_DIR/v2-missing-children.json" >/dev/null 2>&1; then
    fail "Case 3: missing children field should be rejected"
fi
pass "Case 3: missing children field rejected"

echo "OK: tests/validate-decomposition-v2-branch.sh"
