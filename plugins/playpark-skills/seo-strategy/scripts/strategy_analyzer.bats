#!/usr/bin/env bats
# test_strategy_analyzer.py（unittest）を tests/run-all-bats.sh 経由で discovery できるようにする
# wrapper。個別の assert は unittest 側が持つので、ここでは exit 0 で完走したかだけを pin する。

@test "test_strategy_analyzer.py の unittest が全件 pass する" {
  cd "$BATS_TEST_DIRNAME"
  run python3 -B -m unittest test_strategy_analyzer.py
  echo "$output"
  [ "$status" -eq 0 ]
}
