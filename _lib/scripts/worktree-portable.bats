#!/usr/bin/env bats
# worktree-portable.bats — minimal coverage for the portable worktree adapter
# (replacement for Claude Code's `isolation: worktree`).

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  CREATE_SH="$REPO_ROOT/_lib/scripts/worktree-create.sh"
  FINALIZE_SH="$REPO_ROOT/_lib/scripts/worktree-finalize.sh"

  TMP=$(mktemp -d -t wt-portable.XXXXXX)
  cd "$TMP"
  git init -q -b main
  git config user.email "test@example.com"
  git config user.name "test"
  echo "hello" > README.md
  git add README.md
  git commit -qm "init"
  REPO_NAME=$(basename "$TMP")
  WT_ROOT="$(dirname "$TMP")/${REPO_NAME}-worktrees"
}

teardown() {
  cd /tmp
  if [ -n "${WT_ROOT:-}" ] && [ -d "$WT_ROOT" ]; then
    rm -rf "$WT_ROOT"
  fi
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}

@test "create: usage error when no arguments" {
  run bash "$CREATE_SH"
  [ "$status" -eq 1 ]
}

@test "create: makes worktree and emits its absolute path" {
  run bash "$CREATE_SH" 999 main
  [ "$status" -eq 0 ]
  WT_PATH="$output"
  [ -d "$WT_PATH" ]
  [ -f "$WT_PATH/README.md" ]
  [ "$(git -C "$WT_PATH" branch --show-current)" = "feature/issue-999" ]
}

@test "create: fails when the branch already exists" {
  bash "$CREATE_SH" 999 main >/dev/null
  run bash "$CREATE_SH" 999 main
  [ "$status" -eq 2 ]
}

@test "finalize: usage error when no arguments" {
  run bash "$FINALIZE_SH"
  [ "$status" -eq 1 ]
}

@test "finalize: auto-cleans worktree with no changes" {
  WT_PATH=$(bash "$CREATE_SH" 999 main)
  [ -d "$WT_PATH" ]
  run bash "$FINALIZE_SH" "$WT_PATH" main
  [ "$status" -eq 0 ]
  [[ "$output" == *'"changed":false'* ]]
  [ ! -d "$WT_PATH" ]
}

@test "finalize: reports changed=true after a commit and retains the worktree" {
  WT_PATH=$(bash "$CREATE_SH" 999 main)
  ( cd "$WT_PATH" && echo "added" > new-file.txt && git add new-file.txt && git commit -qm "feat: add file" )

  run bash "$FINALIZE_SH" "$WT_PATH" main
  [ "$status" -eq 0 ]
  [[ "$output" == *'"changed":true'* ]]
  [[ "$output" == *'"branch":"feature/issue-999"'* ]]
  [ -d "$WT_PATH" ]
}

@test "finalize: detects uncommitted changes as changed" {
  WT_PATH=$(bash "$CREATE_SH" 999 main)
  echo "dirty" > "$WT_PATH/dirty.txt"
  run bash "$FINALIZE_SH" "$WT_PATH" main
  [ "$status" -eq 0 ]
  [[ "$output" == *'"changed":true'* ]]
  [ -d "$WT_PATH" ]
}
