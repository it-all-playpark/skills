#!/usr/bin/env bats
# build-all-skills.bats — unit tests for build-all-skills.sh
# TDD: all tests written RED first, then implementation makes them GREEN.
#
# Test cases:
#   1. idempotent         - two consecutive runs produce identical artifact hashes
#   2. stale-deletion     - stale .build/skills/<ghost>/ removed between runs
#   3. coverage           - discover count == built count (dynamic, no hardcoded number)
#   4. failure-exit       - exits non-zero when a skill build fails
#   5. list-discovered    - --list-discovered outputs skill names without building

SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
SCRIPT="$SCRIPT_DIR/build-all-skills.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

make_portable_skill() {
  local root="$1"
  local name="$2"
  mkdir -p "$root/$name"
  cat > "$root/$name/SKILL.md" << EOF
---
name: $name
description: Test skill $name.
version: 1.0.0
---

# $name Body
EOF
}

make_broken_skill() {
  local root="$1"
  local name="$2"
  mkdir -p "$root/$name"
  # Write SKILL.md with no frontmatter (will cause build-skill-overlay to fail on it)
  printf '# Just a body, no frontmatter\n' > "$root/$name/SKILL.md"
}

make_claude_overlay() {
  local root="$1"
  local name="$2"
  mkdir -p "$root/$name/adapters"
  cat > "$root/$name/adapters/claude.yaml" << EOF
model: opus
effort: max
context: fork
allowed-tools:
  - Read
  - Bash
EOF
}

# ---------------------------------------------------------------------------
# Test 1: idempotent — two consecutive runs produce identical artifact hashes
# ---------------------------------------------------------------------------
@test "idempotent: two runs produce identical SKILL.md content" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local fake_repo="$tmpdir/repo"
  mkdir -p "$fake_repo"

  make_portable_skill "$fake_repo" "skill-alpha"
  make_portable_skill "$fake_repo" "skill-beta"
  make_claude_overlay "$fake_repo" "skill-alpha"

  run bash "$SCRIPT" --repo-root "$fake_repo" 2>/dev/null
  [ "$status" -eq 0 ]

  local hash1
  hash1="$(find "$fake_repo/.build/skills" -name 'SKILL.md' | sort | xargs md5 2>/dev/null || find "$fake_repo/.build/skills" -name 'SKILL.md' | sort | xargs md5sum 2>/dev/null)"

  # Run again
  run bash "$SCRIPT" --repo-root "$fake_repo" 2>/dev/null
  [ "$status" -eq 0 ]

  local hash2
  hash2="$(find "$fake_repo/.build/skills" -name 'SKILL.md' | sort | xargs md5 2>/dev/null || find "$fake_repo/.build/skills" -name 'SKILL.md' | sort | xargs md5sum 2>/dev/null)"

  [ "$hash1" = "$hash2" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 2: stale-deletion — ghost dir removed between runs
# ---------------------------------------------------------------------------
@test "stale-deletion: stale .build/skills/<ghost>/ is removed on rebuild" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local fake_repo="$tmpdir/repo"
  mkdir -p "$fake_repo"

  make_portable_skill "$fake_repo" "skill-alpha"

  # First run
  run bash "$SCRIPT" --repo-root "$fake_repo" 2>/dev/null
  [ "$status" -eq 0 ]
  [ -d "$fake_repo/.build/skills/skill-alpha" ]

  # Inject stale ghost entry
  mkdir -p "$fake_repo/.build/skills/_ghost-deleted"

  # Second run — should remove the ghost
  run bash "$SCRIPT" --repo-root "$fake_repo" 2>/dev/null
  [ "$status" -eq 0 ]

  # Ghost must be gone
  [ ! -d "$fake_repo/.build/skills/_ghost-deleted" ]
  # Real skill still present
  [ -d "$fake_repo/.build/skills/skill-alpha" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3: coverage — discovered skill count == built skill count
# ---------------------------------------------------------------------------
@test "coverage: discovered skill count equals built artifact count" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local fake_repo="$tmpdir/repo"
  mkdir -p "$fake_repo"

  make_portable_skill "$fake_repo" "skill-alpha"
  make_portable_skill "$fake_repo" "skill-beta"
  make_portable_skill "$fake_repo" "skill-gamma"

  run bash "$SCRIPT" --repo-root "$fake_repo" 2>/dev/null
  [ "$status" -eq 0 ]

  local discovered_count
  discovered_count="$(bash "$SCRIPT" --repo-root "$fake_repo" --list-discovered 2>/dev/null | wc -l | tr -d ' ')"

  local built_count
  built_count="$(find "$fake_repo/.build/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"

  [ "$discovered_count" -eq "$built_count" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 4: failure-exit — exits non-zero when at least one skill build fails
# ---------------------------------------------------------------------------
@test "failure-exit: exits non-zero when a skill has malformed SKILL.md" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local fake_repo="$tmpdir/repo"
  mkdir -p "$fake_repo"

  make_portable_skill "$fake_repo" "skill-good"
  make_broken_skill "$fake_repo" "skill-broken"

  run bash "$SCRIPT" --repo-root "$fake_repo" 2>/dev/null
  [ "$status" -ne 0 ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 5: list-discovered — --list-discovered outputs names without building
# ---------------------------------------------------------------------------
@test "list-discovered: outputs skill names to stdout without building" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local fake_repo="$tmpdir/repo"
  mkdir -p "$fake_repo"

  make_portable_skill "$fake_repo" "skill-alpha"
  make_portable_skill "$fake_repo" "skill-beta"

  run bash "$SCRIPT" --repo-root "$fake_repo" --list-discovered
  [ "$status" -eq 0 ]
  [[ "$output" =~ "skill-alpha" ]]
  [[ "$output" =~ "skill-beta" ]]

  # Must NOT have built anything
  [ ! -d "$fake_repo/.build/skills" ]

  /bin/rm -rf "$tmpdir"
}
