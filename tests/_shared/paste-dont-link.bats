#!/usr/bin/env bats
# test-paste-dont-link.sh を tests/run-all-bats.sh 経由で discovery できるようにする wrapper。
# test-paste-dont-link.sh 自体が独立した bash test harness（内部で個別 assert を持つ）なので、
# ここでは exit 0 で完走したかだけを pin する。

@test "test-paste-dont-link.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/test-paste-dont-link.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}
