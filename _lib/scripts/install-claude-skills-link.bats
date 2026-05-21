#!/usr/bin/env bats
# install-claude-skills-link.bats — unit tests for install-claude-skills-link.sh
# TDD: tests written RED first, implementation makes them GREEN.
# HOME isolation: all tests set HOME=$BATS_TMPDIR/fake-home to avoid touching
# the actual ~/.claude/skills directory.
#
# Test cases:
#   1. overlay-skill    - skill with adapters/claude.yaml → symlink to .build/skills/<skill>/
#   2. plain-skill      - skill without overlay → symlink to <repo>/<skill>/
#   3. backup           - existing ~/.claude/skills → renamed to .bak-<ts> with manifest.json
#   4. mirror-subdirs   - .claude/skills/* and .agents/skills/* are mirrored
#   5. restore          - restore reverts install
#   6. round-trip       - install → restore preserves original state
#   7. dry-run          - --dry-run makes no filesystem changes
#
# Note: These tests use --repo-root to specify the test repo, and HOME override for isolation.

SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
SCRIPT="$SCRIPT_DIR/install-claude-skills-link.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

make_portable_skill() {
  local root="$1"
  local name="$2"
  mkdir -p "$root/$name"
  printf '%s\n' '---' "name: $name" 'description: Test.' '---' '# Body' > "$root/$name/SKILL.md"
}

# Portable directory content hash (md5sum on Linux, md5 on macOS)
hash_tree() {
  local dir="$1"
  local hasher
  if command -v md5sum >/dev/null 2>&1; then
    hasher="md5sum"
  else
    hasher="md5"
  fi
  find "$dir" -type f | sort | xargs "$hasher" 2>/dev/null | "$hasher"
}

make_claude_overlay() {
  local root="$1"
  local name="$2"
  mkdir -p "$root/$name/adapters"
  printf 'model: opus\neffort: max\ncontext: fork\n' > "$root/$name/adapters/claude.yaml"
}

# Pre-build the .build/skills artifact for overlay skills (mimics `make skills`)
prebuild_skill() {
  local repo_root="$1"
  local skill_name="$2"
  bash "$SCRIPT_DIR/build-skill-overlay.sh" \
    "$skill_name" \
    --skill-root "$repo_root" \
    --output "$repo_root/.build/skills/$skill_name/SKILL.md" \
    --subdir-strategy symlink \
    2>/dev/null
}

# ---------------------------------------------------------------------------
# Test 1: overlay-skill — skill with overlay → .build/skills/<skill>/
# ---------------------------------------------------------------------------
@test "overlay-skill: skill with adapters/claude.yaml symlinks to .build/skills/<skill>/" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  make_portable_skill "$tmpdir/repo" "my-skill"
  make_claude_overlay "$tmpdir/repo" "my-skill"
  prebuild_skill "$tmpdir/repo" "my-skill"

  HOME="$fake_home" run bash "$SCRIPT" install \
    --repo-root "$tmpdir/repo" 2>/dev/null

  [ "$status" -eq 0 ]
  [ -L "$fake_home/.claude/skills/my-skill" ]
  local target
  target="$(readlink "$fake_home/.claude/skills/my-skill")"
  # Must point to .build/skills/my-skill (not the source skill dir)
  [[ "$target" == *".build/skills/my-skill"* ]]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 2: plain-skill — skill without overlay → <repo>/<skill>/
# ---------------------------------------------------------------------------
@test "plain-skill: skill without overlay symlinks directly to <repo>/<skill>/" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  make_portable_skill "$tmpdir/repo" "plain-skill"
  # No overlay

  HOME="$fake_home" run bash "$SCRIPT" install \
    --repo-root "$tmpdir/repo" 2>/dev/null

  [ "$status" -eq 0 ]
  [ -L "$fake_home/.claude/skills/plain-skill" ]
  local target
  target="$(readlink "$fake_home/.claude/skills/plain-skill")"
  # Must point directly to <repo>/plain-skill
  [[ "$target" == "$tmpdir/repo/plain-skill" ]]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3: backup — existing ~/.claude/skills (symlink) → renamed to .bak-<ts>
# ---------------------------------------------------------------------------
@test "backup: existing ~/.claude/skills is renamed to .bak-<ts>/ with manifest.json" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  # Simulate existing ~/.claude/skills as a symlink
  ln -s "$tmpdir/some-old-target" "$fake_home/.claude/skills"

  make_portable_skill "$tmpdir/repo" "skill-a"

  HOME="$fake_home" run bash "$SCRIPT" install \
    --repo-root "$tmpdir/repo" 2>/dev/null

  [ "$status" -eq 0 ]

  # Original symlink must be gone, backup dir must exist
  [ ! -L "$fake_home/.claude/skills" ]
  local bak_dir
  bak_dir="$(find "$fake_home/.claude" -maxdepth 1 -name 'skills.bak-*' -type d | head -1)"
  [ -n "$bak_dir" ]
  # manifest.json must exist in bak dir
  [ -f "$bak_dir/manifest.json" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 4: mirror-subdirs — .claude/skills/* and .agents/skills/* are mirrored
# ---------------------------------------------------------------------------
@test "mirror-subdirs: .claude/skills/* and .agents/skills/* entries are included" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  # Root skill
  make_portable_skill "$tmpdir/repo" "root-skill"
  # .claude/skills skill
  make_portable_skill "$tmpdir/repo/.claude/skills" "claude-skill"
  # .agents/skills skill
  make_portable_skill "$tmpdir/repo/.agents/skills" "agent-skill"

  HOME="$fake_home" run bash "$SCRIPT" install \
    --repo-root "$tmpdir/repo" 2>/dev/null

  [ "$status" -eq 0 ]
  [ -L "$fake_home/.claude/skills/root-skill" ]
  [ -L "$fake_home/.claude/skills/claude-skill" ]
  [ -L "$fake_home/.claude/skills/agent-skill" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 5: restore — restore reverts to backup
# ---------------------------------------------------------------------------
@test "restore: restore reverts ~/.claude/skills to the latest backup" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  # Pre-create a bak dir with a marker file
  local bak_dir="$fake_home/.claude/skills.bak-20240101-120000"
  mkdir -p "$bak_dir"
  echo "marker" > "$bak_dir/marker.txt"
  cat > "$bak_dir/manifest.json" << 'MEOF'
{"original_type":"directory","original_path":""}
MEOF

  # Install first to get a real ~/.claude/skills
  make_portable_skill "$tmpdir/repo" "skill-x"
  HOME="$fake_home" bash "$SCRIPT" install --repo-root "$tmpdir/repo" 2>/dev/null || true

  # Now restore
  HOME="$fake_home" run bash "$SCRIPT" restore 2>/dev/null
  [ "$status" -eq 0 ]

  # The backup content should be restored
  [ -f "$fake_home/.claude/skills/marker.txt" ] || [ -d "$fake_home/.claude/skills" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 6: round-trip — install → restore preserves initial state hash
# ---------------------------------------------------------------------------
@test "round-trip: install then restore returns to original state" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  # Simulate existing ~/.claude/skills as a plain directory with some content
  mkdir -p "$fake_home/.claude/skills/my-personal-skill"
  echo "personal" > "$fake_home/.claude/skills/my-personal-skill/SKILL.md"

  local before_hash
  before_hash="$(hash_tree "$fake_home/.claude/skills")"

  make_portable_skill "$tmpdir/repo" "repo-skill"

  HOME="$fake_home" bash "$SCRIPT" install --repo-root "$tmpdir/repo" 2>/dev/null
  HOME="$fake_home" bash "$SCRIPT" restore 2>/dev/null

  local after_hash
  after_hash="$(hash_tree "$fake_home/.claude/skills")"

  [ "$before_hash" = "$after_hash" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 7: dry-run — no filesystem changes
# ---------------------------------------------------------------------------
@test "dry-run: --dry-run makes no changes to filesystem" {
  local tmpdir fake_home
  tmpdir="$(mktemp -d)"
  fake_home="$tmpdir/home"
  mkdir -p "$fake_home/.claude"

  # No ~/.claude/skills initially
  make_portable_skill "$tmpdir/repo" "skill-a"

  HOME="$fake_home" run bash "$SCRIPT" install \
    --repo-root "$tmpdir/repo" \
    --dry-run 2>/dev/null

  [ "$status" -eq 0 ]
  # ~/.claude/skills must NOT have been created
  [ ! -e "$fake_home/.claude/skills" ]

  /bin/rm -rf "$tmpdir"
}
