#!/usr/bin/env bats
# Runs the ported self-contained test harnesses (*.test.sh) so they're
# discovered by tests/run-all-bats.sh (which only globs *.bats).

@test "posttool-secret-mask.test.sh passes" {
  run bash "$BATS_TEST_DIRNAME/posttool-secret-mask.test.sh"
  [ "$status" -eq 0 ]
}

@test "pretool-context-guard.test.sh passes" {
  run bash "$BATS_TEST_DIRNAME/pretool-context-guard.test.sh"
  [ "$status" -eq 0 ]
}
