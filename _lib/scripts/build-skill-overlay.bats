#!/usr/bin/env bats
# build-skill-overlay.bats — unit tests for build-skill-overlay.sh
# TDD: all tests are written RED first, then the implementation makes them GREEN.
#
# Test cases:
#   1. usage              - print help and exit 1 when called without args
#   2. portable-only      - pass-through when no overlay file exists (exit 0)
#   3. merge-success      - portable + claude.yaml overlay produces correct merged SKILL.md
#   4. missing-overlay    - missing adapter file causes exit 0 with portable content
#   5. invalid-yaml       - malformed overlay YAML causes exit 2 + stderr message
#   6. field-collision    - overlay field 'name' overrides portable value (overlay wins)
#   7. output-to-file     - --output writes merged content to specified path
#   8. default-output-build-dir  - default output is <repo>/.build/skills/<skill>/SKILL.md
#   9. subdir-strategy-symlink   - --subdir-strategy symlink creates absolute symlinks for subdirs
#  10. subdir-strategy-copy      - --subdir-strategy copy creates deep copies of subdirs

SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
SCRIPT="$SCRIPT_DIR/build-skill-overlay.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Create a minimal portable SKILL.md in a temp directory.
# Usage: make_portable_skill <dir> [<name>]
make_portable_skill() {
  local dir="$1"
  local name="${2:-test-skill}"
  mkdir -p "$dir/$name"
  cat > "$dir/$name/SKILL.md" << EOF
---
name: $name
description: |
  A test skill for unit testing.
  Use when: testing build-skill-overlay.sh
version: 1.0.0
tags:
  - test
agents:
  - claude
  - codex
---

# Test Skill Body

This is the body of the test skill.

## Usage

/test-skill
EOF
}

# Create a valid claude adapter overlay in <dir>/<name>/adapters/claude.yaml.
make_claude_overlay() {
  local dir="$1"
  local name="${2:-test-skill}"
  mkdir -p "$dir/$name/adapters"
  cat > "$dir/$name/adapters/claude.yaml" << EOF
# Claude Code adapter overlay for $name
# Merged into SKILL.md frontmatter by build-skill-overlay.sh
model: opus
effort: max
context: fork
allowed-tools:
  - Read
  - Bash
EOF
}

# ---------------------------------------------------------------------------
# Test 1: usage — no args → exit 1 + help on stderr
# ---------------------------------------------------------------------------
@test "usage: exits 1 and prints help when called without args" {
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "usage" ]] || [[ "$stderr" =~ "usage" ]]
}

# ---------------------------------------------------------------------------
# Test 2: portable-only — no overlay → pass-through, exit 0
# ---------------------------------------------------------------------------
@test "portable-only: outputs SKILL.md unchanged when overlay is absent" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"

  local out_file="$tmpdir/merged.md"
  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file"
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]
  # Body must be preserved
  grep -q "Test Skill Body" "$out_file"
  # Portable fields must be present
  grep -q "^name: test-skill" "$out_file"
  # Claude-ext fields must NOT appear (no overlay)
  ! grep -q "^model:" "$out_file"

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3: merge-success — portable + overlay → all fields in output
# ---------------------------------------------------------------------------
@test "merge-success: merged SKILL.md contains both portable and overlay fields" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"
  make_claude_overlay "$tmpdir"

  local out_file="$tmpdir/merged.md"
  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file"
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]

  # Portable fields preserved
  grep -q "^name: test-skill" "$out_file"
  grep -q "^version: 1.0.0" "$out_file"

  # Claude-ext fields from overlay
  grep -q "^model: opus" "$out_file"
  grep -q "^effort: max" "$out_file"
  grep -q "^context: fork" "$out_file"
  grep -q "allowed-tools" "$out_file"

  # Body preserved unchanged
  grep -q "Test Skill Body" "$out_file"
  grep -q "^## Usage" "$out_file"

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 4: missing-overlay — no adapter/claude.yaml → exit 0, portable content
# ---------------------------------------------------------------------------
@test "missing-overlay: exits 0 with portable passthrough when adapter file absent" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"
  # NOTE: we do NOT create adapters/claude.yaml

  local out_file="$tmpdir/merged.md"
  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file"
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]
  grep -q "name: test-skill" "$out_file"
  # No Claude-ext fields injected
  ! grep -q "^model:" "$out_file"

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 5: invalid-yaml — malformed overlay → exit 2
# ---------------------------------------------------------------------------
@test "invalid-yaml-overlay: malformed adapter YAML causes exit 2 with error on stderr" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"
  mkdir -p "$tmpdir/test-skill/adapters"
  # Write syntactically invalid YAML
  printf 'model: opus\ninvalid: [unclosed\n' > "$tmpdir/test-skill/adapters/claude.yaml"

  local out_file="$tmpdir/merged.md"
  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file"
  [ "$status" -eq 2 ]
  # Error message must appear in combined output
  [[ "$output" =~ "error" ]] || [[ "$output" =~ "parse" ]] || [[ "$output" =~ "YAML" ]]

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 6: field-collision — overlay 'name' overrides portable 'name'
# ---------------------------------------------------------------------------
@test "field-collision: overlay wins when same key exists in portable (with warning)" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"  # name: test-skill
  mkdir -p "$tmpdir/test-skill/adapters"
  cat > "$tmpdir/test-skill/adapters/claude.yaml" << EOF
model: opus
name: overridden-name
EOF

  local out_file="$tmpdir/merged.md"
  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file"
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]
  # Overlay wins: name should be overridden-name
  grep -q "name: overridden-name" "$out_file"
  # Warning must appear (in stdout or stderr)
  [[ "$output" =~ "warning" ]] || [[ "$output" =~ "override" ]] || [[ "$output" =~ "overrides" ]]

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 7: output-to-file — --output writes to specified path
# ---------------------------------------------------------------------------
@test "output-to-file: --output writes merged SKILL.md to specified path" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"
  make_claude_overlay "$tmpdir"

  local out_dir="$tmpdir/out/nested"
  local out_file="$out_dir/SKILL.md"

  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file"
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]
  grep -q "model: opus" "$out_file"
  grep -q "Test Skill Body" "$out_file"

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 8: default-output-build-dir — default output is <repo>/.build/skills/<skill>/SKILL.md
# ---------------------------------------------------------------------------
@test "default-output-build-dir: default output path is <skill-root>/.build/skills/<skill>/SKILL.md" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"

  # Run WITHOUT --output so default path is used
  run bash "$SCRIPT" test-skill --skill-root "$tmpdir"
  [ "$status" -eq 0 ]

  local expected_path="$tmpdir/.build/skills/test-skill/SKILL.md"
  [ -f "$expected_path" ]
  grep -q "name: test-skill" "$expected_path"

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 9: subdir-strategy-symlink — --subdir-strategy symlink creates absolute symlinks
# ---------------------------------------------------------------------------
@test "subdir-strategy-symlink: creates absolute symlinks for skill subdirs in build artifact dir" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"
  make_claude_overlay "$tmpdir"
  # Create a references/ subdir in the source skill
  mkdir -p "$tmpdir/test-skill/references"
  echo "# Reference doc" > "$tmpdir/test-skill/references/guide.md"
  mkdir -p "$tmpdir/test-skill/scripts"
  echo "#!/usr/bin/env bash" > "$tmpdir/test-skill/scripts/run.sh"

  local out_file="$tmpdir/.build/skills/test-skill/SKILL.md"

  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file" --subdir-strategy symlink
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]

  # references/ and scripts/ should be symlinks in the build artifact dir
  local build_dir
  build_dir="$(dirname "$out_file")"
  [ -L "$build_dir/references" ]
  [ -L "$build_dir/scripts" ]

  # Symlinks must be absolute (not relative)
  local ref_target
  ref_target="$(readlink "$build_dir/references")"
  [[ "$ref_target" == /* ]]

  # Symlink should resolve correctly (file inside is accessible)
  [ -f "$build_dir/references/guide.md" ]

  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 10: subdir-strategy-copy — --subdir-strategy copy creates deep copies
# ---------------------------------------------------------------------------
@test "subdir-strategy-copy: creates deep copies of skill subdirs in build artifact dir" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  make_portable_skill "$tmpdir"
  make_claude_overlay "$tmpdir"
  # Create a references/ subdir in the source skill
  mkdir -p "$tmpdir/test-skill/references"
  echo "# Reference doc" > "$tmpdir/test-skill/references/guide.md"

  local out_file="$tmpdir/.build/skills/test-skill/SKILL.md"

  run bash "$SCRIPT" test-skill --skill-root "$tmpdir" --output "$out_file" --subdir-strategy copy
  [ "$status" -eq 0 ]
  [ -f "$out_file" ]

  local build_dir
  build_dir="$(dirname "$out_file")"
  # references/ must NOT be a symlink but a real directory
  [ -d "$build_dir/references" ]
  [ ! -L "$build_dir/references" ]

  # File inside should be present as a copy
  [ -f "$build_dir/references/guide.md" ]

  rm -rf "$tmpdir"
}
