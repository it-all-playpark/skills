#!/usr/bin/env bats
# fixer-finish.bats
setup() {
  REPO="$(mktemp -d)"; cd "$REPO"
  git init -q; git config user.email t@t; git config user.name t
  echo a > f.txt; git add f.txt; git commit -qm init
  SCRIPT="${BATS_TEST_DIRNAME}/fixer-finish.sh"
}
teardown() { rm -rf "$REPO"; }

@test "変更なしなら no_changes を JSON で返し commit しない" {
  run bash "$SCRIPT" --no-push
  [ "$status" -eq 0 ]
  [[ "$output" == *'"result":"no_changes"'* ]]
}

@test "変更ありなら commit して committed を返す" {
  echo b >> f.txt
  run bash "$SCRIPT" --no-push --message "fix: tweak"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"result":"committed"'* ]]
  run git log --oneline -1
  [[ "$output" == *"fix: tweak"* ]]
}

@test "push パスで bare remote に反映される" {
  BARE="$(mktemp -d)"; git init -q --bare "$BARE"
  git remote add origin "$BARE"
  git push -q -u origin HEAD 2>/dev/null || git push -q -u origin master
  echo z >> f.txt
  run bash "$SCRIPT" --message "fix: push"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"result":"committed"'* ]]
  rm -rf "$BARE"
}
