#!/usr/bin/env bats
# lint-portable-frontmatter.bats — verify SKILL.md portable subset lint behavior.
#
# The lint script scans SKILL.md files under a target root and reports which
# Claude Code 拡張 frontmatter fields are still in use. It is invariant: the
# JSON shape and counts must stay consistent so CI can track migration progress
# toward portable subset (see issue #103).

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="$REPO_ROOT/_lib/scripts/lint-portable-frontmatter.sh"

  TMP=$(mktemp -d -t lint-portable.XXXXXX)
}

teardown() {
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}

# Helper: create a SKILL.md with the given frontmatter body.
make_skill() {
  local dir="$1"
  local body="$2"
  mkdir -p "$dir"
  cat > "$dir/SKILL.md" <<EOF
---
$body
---

# body
EOF
}

@test "usage: prints help and exits 1 when called without --root" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 1 ]
  [[ "$output" == *"usage"* ]]
}

@test "empty: emits scanned:0 when target has no SKILL.md" {
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"scanned": 0'* ]]
}

@test "portable-only: zero ext_field_usage when only portable fields present" {
  make_skill "$TMP/skill-a" $'name: skill-a\ndescription: portable-only test'
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"scanned": 1'* ]]
  [[ "$output" == *'"files_with_ext_fields": 0'* ]]
}

@test "model: ext_field_usage.model >= 1 when SKILL.md sets model" {
  make_skill "$TMP/skill-b" $'name: skill-b\ndescription: test\nmodel: opus'
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"model": 1'* ]]
  [[ "$output" == *'"files_with_ext_fields": 1'* ]]
}

@test "multiple ext fields: counts each field independently" {
  make_skill "$TMP/skill-c" $'name: skill-c\ndescription: test\nmodel: sonnet\neffort: max\ncontext: fork'
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"model": 1'* ]]
  [[ "$output" == *'"effort": 1'* ]]
  [[ "$output" == *'"context": 1'* ]]
}

@test "allowed-tools as block scalar: counted as ext field" {
  make_skill "$TMP/skill-d" $'name: skill-d\ndescription: test\nallowed-tools:\n  - Read\n  - Grep'
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"allowed-tools": 1'* ]]
}

@test "multiple skills: aggregates ext_field_usage across files" {
  make_skill "$TMP/s1" $'name: s1\ndescription: t\nmodel: opus'
  make_skill "$TMP/s2" $'name: s2\ndescription: t\nmodel: sonnet'
  make_skill "$TMP/s3" $'name: s3\ndescription: t'
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"scanned": 3'* ]]
  [[ "$output" == *'"model": 2'* ]]
  [[ "$output" == *'"files_with_ext_fields": 2'* ]]
}

@test "exclude .agents/: upstream skill files are skipped" {
  make_skill "$TMP/.agents/skills/upstream" $'name: upstream\ndescription: t\nmodel: opus'
  make_skill "$TMP/local" $'name: local\ndescription: t'
  run bash "$SCRIPT" --root "$TMP" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"scanned": 1'* ]]
  [[ "$output" == *'"model": 0'* ]]
}

@test "strict mode: exits 2 when any ext field is present" {
  make_skill "$TMP/skill-e" $'name: skill-e\ndescription: t\nmodel: opus'
  run bash "$SCRIPT" --root "$TMP" --strict
  [ "$status" -eq 2 ]
  [[ "$output" == *"non-portable"* ]] || [[ "$output" == *"strict"* ]]
}

@test "strict mode: exits 0 when all SKILL.md are portable" {
  make_skill "$TMP/skill-f" $'name: skill-f\ndescription: portable only'
  run bash "$SCRIPT" --root "$TMP" --strict
  [ "$status" -eq 0 ]
}

@test "text mode: emits human-readable summary by default" {
  make_skill "$TMP/skill-g" $'name: skill-g\ndescription: t\nmodel: opus'
  run bash "$SCRIPT" --root "$TMP"
  [ "$status" -eq 0 ]
  [[ "$output" == *"scanned"* ]]
  [[ "$output" == *"model"* ]]
}
