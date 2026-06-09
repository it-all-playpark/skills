#!/usr/bin/env bats
# redgreen-verify.sh: impl を stash して test が red→green に転じるか判定する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/redgreen-verify.sh"
  REPO="$(mktemp -d)"
  cd "$REPO"
  git init -q && git config user.email t@t && git config user.name t
  echo "export const ok = false;" > impl.mjs
  git add impl.mjs && git commit -q -m base
  # impl を true にし、それを検証する test を worktree に置く(未 commit = implementer の変更相当)
  echo "export const ok = true;" > impl.mjs
  cat > feature.test.mjs <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './impl.mjs';
test('ok is true', () => { assert.equal(ok, true); });
EOF
}
teardown() { rm -rf "$REPO"; }

@test "red→green: impl 退避で red、復元で green" {
  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
}

@test "非 test ファイル申告は exit 2(昇格拒否)" {
  run bash "$SCRIPT" "$REPO" "impl.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'non-test file'* ]]
}

@test "test と impl が同一ファイル(混在)は exit 2" {
  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "feature.test.mjs"
  [ "$status" -eq 2 ]
}
