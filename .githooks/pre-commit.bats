#!/usr/bin/env bats
# pre-commit.bats — unit tests for .githooks/pre-commit
# TDD: tests written RED first.
#
# Test cases:
#   1. skill-md-change      - SKILL.md change triggers rebuild of that skill only
#   2. adapter-change       - adapters/claude.yaml change triggers rebuild
#   3. unrelated-change     - unrelated file change is a no-op (no rebuild)
#   4. skip-rebuild-env     - SKIP_SKILL_REBUILD=1 skips all rebuild
#   5. rebuild-failure      - rebuild failure causes hook to exit non-zero
#
# The hook is tested by providing a mock git diff output and a fake
# build-skill-overlay.sh that records calls.

HOOK_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
HOOK="$HOOK_DIR/pre-commit"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

make_git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@test.com"
  git -C "$dir" config user.name "Test"
}

make_portable_skill() {
  local root="$1"
  local name="$2"
  mkdir -p "$root/$name"
  printf '%s\n' '---' "name: $name" 'description: Test.' '---' '# Body' > "$root/$name/SKILL.md"
}

# Run the hook with a mocked git diff output and capture rebuilt skills
run_hook_with_diff() {
  local tmpdir="$1"
  local diff_files="$2"   # newline-separated list of changed files
  local expect_exit="${3:-0}"

  # Create a fake build-skill-overlay.sh that records calls
  local fake_build="$tmpdir/fake_build.sh"
  cat > "$fake_build" << 'FAKE'
#!/usr/bin/env bash
# Record which skill was rebuilt
skill_name="$1"
echo "$skill_name" >> "$TMPDIR_HOOK/rebuilt_skills.txt"
exit 0
FAKE
  chmod +x "$fake_build"

  # Create a fake git that returns controlled diff output
  local fake_git="$tmpdir/fake_git"
  mkdir -p "$fake_git"
  cat > "$fake_git/git" << GITFAKE
#!/usr/bin/env bash
if [[ "\$*" == "diff --cached --name-only" ]]; then
  printf '%s\n' $diff_files
  exit 0
fi
exec /usr/bin/git "\$@"
GITFAKE
  chmod +x "$fake_git/git"

  export TMPDIR_HOOK="$tmpdir"
  export BUILD_SKILL_OVERLAY="$fake_build"
  export PATH="$fake_git:$PATH"
  export REPO_ROOT="$tmpdir/repo"

  bash "$HOOK"
}

# ---------------------------------------------------------------------------
# Test 1: SKILL.md change → rebuild of that skill only
# ---------------------------------------------------------------------------
@test "skill-md-change: SKILL.md change triggers rebuild of affected skill" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local repo="$tmpdir/repo"
  make_git_repo "$repo"
  make_portable_skill "$repo" "my-skill"

  touch "$tmpdir/rebuilt_skills.txt"

  export TMPDIR_HOOK="$tmpdir"
  export BUILD_SKILL_OVERLAY="$tmpdir/fake_build.sh"
  export REPO_ROOT="$repo"

  # Create fake build script
  cat > "$tmpdir/fake_build.sh" << 'BEOF'
#!/usr/bin/env bash
echo "$1" >> "$TMPDIR_HOOK/rebuilt_skills.txt"
exit 0
BEOF
  chmod +x "$tmpdir/fake_build.sh"

  # Create fake git diff returning my-skill/SKILL.md
  local fake_git_dir="$tmpdir/fakebin"
  mkdir -p "$fake_git_dir"
  cat > "$fake_git_dir/git" << 'GEOF'
#!/usr/bin/env bash
if [[ "$*" == "diff --cached --name-only" ]]; then
  echo "my-skill/SKILL.md"
  exit 0
fi
exec /usr/bin/git "$@"
GEOF
  chmod +x "$fake_git_dir/git"

  PATH="$fake_git_dir:$PATH" run bash "$HOOK"
  [ "$status" -eq 0 ]
  grep -q "my-skill" "$tmpdir/rebuilt_skills.txt"

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 2: adapters/claude.yaml change → rebuild
# ---------------------------------------------------------------------------
@test "adapter-change: adapters/claude.yaml change triggers rebuild of that skill" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local repo="$tmpdir/repo"
  make_git_repo "$repo"
  make_portable_skill "$repo" "my-skill"
  mkdir -p "$repo/my-skill/adapters"
  printf 'model: opus\n' > "$repo/my-skill/adapters/claude.yaml"

  touch "$tmpdir/rebuilt_skills.txt"
  export TMPDIR_HOOK="$tmpdir"
  export BUILD_SKILL_OVERLAY="$tmpdir/fake_build.sh"
  export REPO_ROOT="$repo"

  cat > "$tmpdir/fake_build.sh" << 'BEOF'
#!/usr/bin/env bash
echo "$1" >> "$TMPDIR_HOOK/rebuilt_skills.txt"
exit 0
BEOF
  chmod +x "$tmpdir/fake_build.sh"

  local fake_git_dir="$tmpdir/fakebin"
  mkdir -p "$fake_git_dir"
  cat > "$fake_git_dir/git" << 'GEOF'
#!/usr/bin/env bash
if [[ "$*" == "diff --cached --name-only" ]]; then
  echo "my-skill/adapters/claude.yaml"
  exit 0
fi
exec /usr/bin/git "$@"
GEOF
  chmod +x "$fake_git_dir/git"

  PATH="$fake_git_dir:$PATH" run bash "$HOOK"
  [ "$status" -eq 0 ]
  grep -q "my-skill" "$tmpdir/rebuilt_skills.txt"

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 3: unrelated-change → no rebuild
# ---------------------------------------------------------------------------
@test "unrelated-change: non-skill file change does not trigger rebuild" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local repo="$tmpdir/repo"
  make_git_repo "$repo"

  touch "$tmpdir/rebuilt_skills.txt"
  export TMPDIR_HOOK="$tmpdir"
  export BUILD_SKILL_OVERLAY="$tmpdir/fake_build.sh"
  export REPO_ROOT="$repo"

  cat > "$tmpdir/fake_build.sh" << 'BEOF'
#!/usr/bin/env bash
echo "$1" >> "$TMPDIR_HOOK/rebuilt_skills.txt"
exit 0
BEOF
  chmod +x "$tmpdir/fake_build.sh"

  local fake_git_dir="$tmpdir/fakebin"
  mkdir -p "$fake_git_dir"
  cat > "$fake_git_dir/git" << 'GEOF'
#!/usr/bin/env bash
if [[ "$*" == "diff --cached --name-only" ]]; then
  echo "README.md"
  echo "docs/some-doc.md"
  exit 0
fi
exec /usr/bin/git "$@"
GEOF
  chmod +x "$fake_git_dir/git"

  PATH="$fake_git_dir:$PATH" run bash "$HOOK"
  [ "$status" -eq 0 ]
  # rebuilt_skills.txt must be empty
  [ ! -s "$tmpdir/rebuilt_skills.txt" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 4: SKIP_SKILL_REBUILD=1 → no rebuild
# ---------------------------------------------------------------------------
@test "skip-rebuild-env: SKIP_SKILL_REBUILD=1 skips all rebuilds" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local repo="$tmpdir/repo"
  make_git_repo "$repo"
  make_portable_skill "$repo" "my-skill"

  touch "$tmpdir/rebuilt_skills.txt"
  export TMPDIR_HOOK="$tmpdir"
  export BUILD_SKILL_OVERLAY="$tmpdir/fake_build.sh"
  export REPO_ROOT="$repo"

  cat > "$tmpdir/fake_build.sh" << 'BEOF'
#!/usr/bin/env bash
echo "$1" >> "$TMPDIR_HOOK/rebuilt_skills.txt"
exit 0
BEOF
  chmod +x "$tmpdir/fake_build.sh"

  local fake_git_dir="$tmpdir/fakebin"
  mkdir -p "$fake_git_dir"
  cat > "$fake_git_dir/git" << 'GEOF'
#!/usr/bin/env bash
if [[ "$*" == "diff --cached --name-only" ]]; then
  echo "my-skill/SKILL.md"
  exit 0
fi
exec /usr/bin/git "$@"
GEOF
  chmod +x "$fake_git_dir/git"

  SKIP_SKILL_REBUILD=1 PATH="$fake_git_dir:$PATH" run bash "$HOOK"
  [ "$status" -eq 0 ]
  [ ! -s "$tmpdir/rebuilt_skills.txt" ]

  /bin/rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test 5: rebuild failure → hook exits non-zero
# ---------------------------------------------------------------------------
@test "rebuild-failure: failed rebuild causes hook to exit non-zero" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local repo="$tmpdir/repo"
  make_git_repo "$repo"
  make_portable_skill "$repo" "my-skill"

  export TMPDIR_HOOK="$tmpdir"
  export BUILD_SKILL_OVERLAY="$tmpdir/fake_build.sh"
  export REPO_ROOT="$repo"

  # Fake build that fails
  cat > "$tmpdir/fake_build.sh" << 'BEOF'
#!/usr/bin/env bash
echo "$1" >&2
exit 2
BEOF
  chmod +x "$tmpdir/fake_build.sh"

  local fake_git_dir="$tmpdir/fakebin"
  mkdir -p "$fake_git_dir"
  cat > "$fake_git_dir/git" << 'GEOF'
#!/usr/bin/env bash
if [[ "$*" == "diff --cached --name-only" ]]; then
  echo "my-skill/SKILL.md"
  exit 0
fi
exec /usr/bin/git "$@"
GEOF
  chmod +x "$fake_git_dir/git"

  PATH="$fake_git_dir:$PATH" run bash "$HOOK"
  [ "$status" -ne 0 ]

  /bin/rm -rf "$tmpdir"
}
