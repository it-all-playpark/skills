#!/usr/bin/env bats
# lint-merged-frontmatter.bats — unit tests for lint-merged-frontmatter.sh
# TDD: tests written RED first.
#
# Test cases:
#   1. all-keys-present    - all required keys present → exit 0
#   2. missing-key         - one required key missing → exit non-zero + stderr
#   3. absent-frontmatter  - SKILL.md without frontmatter → exit non-zero
#   4. dev-plan-review     - merged artifact for dev-plan-review passes all 4 checks

SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
SCRIPT="$SCRIPT_DIR/lint-merged-frontmatter.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

make_merged_skill() {
  local dir="$1"
  local include_model="${2:-true}"
  local include_effort="${3:-true}"
  local include_context="${4:-true}"
  local include_tools="${5:-true}"

  mkdir -p "$dir"
  {
    echo "---"
    echo "name: test-skill"
    echo "description: A test skill."
    if $include_model;   then echo "model: opus"; fi
    if $include_effort;  then echo "effort: max"; fi
    if $include_context; then echo "context: fork"; fi
    if $include_tools;   then printf 'allowed-tools:\n  - Read\n  - Bash\n'; fi
    echo "---"
    echo ""
    echo "# Test Skill Body"
  } > "$dir/SKILL.md"
}

# ---------------------------------------------------------------------------
# Test 1: all required keys present → exit 0
# ---------------------------------------------------------------------------
@test "all-keys-present: exits 0 when all required keys exist in frontmatter" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_merged_skill "$tmpdir"

  run bash "$SCRIPT" "$tmpdir/SKILL.md" --require "model,effort,context,allowed-tools"
  [ "$status" -eq 0 ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 2: missing key → exit non-zero + stderr mentions missing key
# ---------------------------------------------------------------------------
@test "missing-key: exits non-zero when a required key is absent" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  # Omit 'context'
  make_merged_skill "$tmpdir" true true false true

  run bash "$SCRIPT" "$tmpdir/SKILL.md" --require "model,effort,context,allowed-tools"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "context" ]]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3: absent frontmatter → exit non-zero
# ---------------------------------------------------------------------------
@test "absent-frontmatter: exits non-zero when SKILL.md has no frontmatter" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  echo "# Just a body, no frontmatter delimiters" > "$tmpdir/SKILL.md"

  run bash "$SCRIPT" "$tmpdir/SKILL.md" --require "model,effort,context,allowed-tools"
  [ "$status" -ne 0 ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 4: dev-plan-review merged artifact passes all 4 required checks
# ---------------------------------------------------------------------------
@test "dev-plan-review: merged artifact contains model, effort, context, allowed-tools" {
  # This test requires build-all-skills to have run first (or we run it here)
  local build_artifact="$REPO_ROOT/.build/skills/dev-plan-review/SKILL.md"

  # If artifact doesn't exist yet, build it first
  if [[ ! -f "$build_artifact" ]]; then
    bash "$REPO_ROOT/_lib/scripts/build-all-skills.sh" \
      --repo-root "$REPO_ROOT" 2>/dev/null || true
  fi

  # Skip if still not present (CI env may not have run make skills yet)
  if [[ ! -f "$build_artifact" ]]; then
    skip "dev-plan-review build artifact not found; run 'make skills' first"
  fi

  run bash "$SCRIPT" "$build_artifact" --require "model,effort,context,allowed-tools"
  [ "$status" -eq 0 ]
}
