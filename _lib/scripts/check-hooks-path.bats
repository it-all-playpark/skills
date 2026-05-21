#!/usr/bin/env bats
# check-hooks-path.bats — unit tests for check-hooks-path.sh
# TDD: tests written RED first.
#
# Test cases:
#   1. unset → --apply sets .githooks, status "set"
#   2. already .githooks → --apply is no-op, status "already_set"
#   3. conflict path → --apply exits non-zero, status "conflict"; --force overrides

SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-hooks-path.sh"

# ---------------------------------------------------------------------------
# Helpers: Create an isolated git repo with a controlled core.hooksPath setting
# ---------------------------------------------------------------------------

setup_git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@test.com"
  git -C "$dir" config user.name "Test"
}

# ---------------------------------------------------------------------------
# Test 1: unset → --apply sets .githooks, status "set"
# ---------------------------------------------------------------------------
@test "unset: --apply sets core.hooksPath to .githooks and returns status=set" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  setup_git_repo "$tmpdir"

  # Ensure core.hooksPath is not set
  git -C "$tmpdir" config --unset core.hooksPath 2>/dev/null || true

  run bash "$SCRIPT" --apply --repo-root "$tmpdir"
  [ "$status" -eq 0 ]

  # Output must be JSON with status = "set"
  local out_status
  out_status="$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])")"
  [ "$out_status" = "set" ]

  # core.hooksPath must now be .githooks
  local current
  current="$(git -C "$tmpdir" config core.hooksPath)"
  [ "$current" = ".githooks" ]

  # JSON must contain target key
  local out_target
  out_target="$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['target'])")"
  [ "$out_target" = ".githooks" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 2: already .githooks → --apply is no-op, status "already_set"
# ---------------------------------------------------------------------------
@test "already-set: --apply returns status=already_set when core.hooksPath is .githooks" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  setup_git_repo "$tmpdir"
  git -C "$tmpdir" config core.hooksPath ".githooks"

  run bash "$SCRIPT" --apply --repo-root "$tmpdir"
  [ "$status" -eq 0 ]

  local out_status
  out_status="$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])")"
  [ "$out_status" = "already_set" ]

  # Still .githooks
  local current
  current="$(git -C "$tmpdir" config core.hooksPath)"
  [ "$current" = ".githooks" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3a: conflict path → --apply exits non-zero with status "conflict"
# ---------------------------------------------------------------------------
@test "conflict: --apply exits non-zero with status=conflict when different hooksPath is set" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  setup_git_repo "$tmpdir"
  git -C "$tmpdir" config core.hooksPath "custom-hooks"

  run bash "$SCRIPT" --apply --repo-root "$tmpdir"
  [ "$status" -ne 0 ]

  local out_status
  out_status="$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])")"
  [ "$out_status" = "conflict" ]

  # current key must be present
  local out_current
  out_current="$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['current'])")"
  [ "$out_current" = "custom-hooks" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3b: conflict + --force → overrides successfully
# ---------------------------------------------------------------------------
@test "conflict-force: --force overrides conflicting hooksPath" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  setup_git_repo "$tmpdir"
  git -C "$tmpdir" config core.hooksPath "custom-hooks"

  run bash "$SCRIPT" --apply --force --repo-root "$tmpdir"
  [ "$status" -eq 0 ]

  local out_status
  out_status="$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])")"
  [ "$out_status" = "set" ]

  # core.hooksPath must now be .githooks
  local current
  current="$(git -C "$tmpdir" config core.hooksPath)"
  [ "$current" = ".githooks" ]

  /bin/rm -rf "$tmpdir"
}
