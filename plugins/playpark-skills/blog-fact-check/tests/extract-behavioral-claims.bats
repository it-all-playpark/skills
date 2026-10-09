#!/usr/bin/env bats
# test-extract-behavioral-claims.sh を tests/run-all-bats.sh 経由で discovery できるようにする
# wrapper。test-extract-behavioral-claims.sh 自体が独立した bash test harness（内部で個別 assert
# を持つ）なので、ここでは exit 0 で完走したかだけを pin する。

@test "test-extract-behavioral-claims.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/test-extract-behavioral-claims.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}
