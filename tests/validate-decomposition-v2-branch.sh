#!/usr/bin/env bash
# AC1: _lib/scripts/validate-decomposition.sh が branch 必須 check を実施することを検証
# 検査対象: with-branch / missing-branch / empty-branch
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/_lib/scripts/validate-decomposition.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Validate fixtures with `jq empty` to catch syntax issues early
validate_json() {
    jq empty "$1" 2>/dev/null || fail "Fixture is not valid JSON: $1"
}

# --- Fixture 1: with branch per subtask ---
cat > "$TMP_DIR/with-branch.json" <<'JSON'
{
  "version": "2.0.0",
  "issue": 1,
  "status": "decomposing",
  "subtasks": [
    {"id": "task1", "scope": "scope-1", "files": ["a.ts"], "branch": "feature/issue-1-task1", "status": "pending", "checklist": [{"item": "x", "done": false}]},
    {"id": "task2", "scope": "scope-2", "files": ["b.ts"], "branch": "feature/issue-1-task2", "status": "pending", "checklist": [{"item": "y", "done": false}]}
  ],
  "config": {"base_branch": "main"}
}
JSON
validate_json "$TMP_DIR/with-branch.json"

# --- Fixture 2: missing branch field ---
cat > "$TMP_DIR/no-branch.json" <<'JSON'
{
  "version": "2.0.0",
  "issue": 1,
  "status": "decomposing",
  "subtasks": [
    {"id": "task1", "scope": "scope-1", "files": ["a.ts"], "status": "pending", "checklist": [{"item": "x", "done": false}]},
    {"id": "task2", "scope": "scope-2", "files": ["b.ts"], "status": "pending", "checklist": [{"item": "y", "done": false}]}
  ],
  "config": {"base_branch": "main"}
}
JSON
validate_json "$TMP_DIR/no-branch.json"

# --- Fixture 3: empty branch string ---
cat > "$TMP_DIR/empty-branch.json" <<'JSON'
{
  "version": "2.0.0",
  "issue": 1,
  "status": "decomposing",
  "subtasks": [
    {"id": "task1", "scope": "scope-1", "files": ["a.ts"], "branch": "", "status": "pending", "checklist": [{"item": "x", "done": false}]},
    {"id": "task2", "scope": "scope-2", "files": ["b.ts"], "branch": "", "status": "pending", "checklist": [{"item": "y", "done": false}]}
  ],
  "config": {"base_branch": "main"}
}
JSON
validate_json "$TMP_DIR/empty-branch.json"

# Case 1: with branch → valid (exit 0)
"$SCRIPT" --flow-state "$TMP_DIR/with-branch.json" >/dev/null 2>&1 \
    || fail "Case 1: with-branch fixture should be valid (got non-zero exit)"
pass "Case 1: per-subtask branch is accepted"

# Case 2: missing branch → rejected (exit 1)
if "$SCRIPT" --flow-state "$TMP_DIR/no-branch.json" >/dev/null 2>&1; then
    fail "Case 2: missing branch should be rejected"
fi
pass "Case 2: missing branch is rejected"

# Case 3: empty branch → rejected (exit 1)
if "$SCRIPT" --flow-state "$TMP_DIR/empty-branch.json" >/dev/null 2>&1; then
    fail "Case 3: empty branch should be rejected"
fi
pass "Case 3: empty branch is rejected"

echo "OK: tests/validate-decomposition-v2-branch.sh"
