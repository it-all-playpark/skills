#!/usr/bin/env bats
# pre-compact-save.bats

@test "pre-compact dump は iterate.json を参照しない" {
  run grep -c "iterate.json" "${BATS_TEST_DIRNAME}/pre-compact-save.sh"
  [ "$output" -eq 0 ]
}
