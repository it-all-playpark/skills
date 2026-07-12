#!/usr/bin/env bats

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/install-external-skills.sh"
  TMP_MANIFEST="$BATS_TEST_TMPDIR/manifest.tsv"
}

@test "dry-run prints deduped add commands" {
  printf '# comment\na\towner/repo1\nb\towner/repo1\nc\towner/repo2\n' >"$TMP_MANIFEST"
  run env MANIFEST="$TMP_MANIFEST" "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"npx skills add owner/repo1 -y"* ]]
  [[ "$output" == *"npx skills add owner/repo2 -y"* ]]
  [ "$(grep -c 'npx skills add owner/repo1 -y' <<<"$output")" -eq 1 ]
}

@test "skills with '-' source are skipped with warning" {
  printf 'a\t-\nb\towner/repo\n' >"$TMP_MANIFEST"
  run env MANIFEST="$TMP_MANIFEST" "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipped (no recorded source): a"* ]]
}

@test "manifest with no installable sources fails" {
  printf 'a\t-\n' >"$TMP_MANIFEST"
  run env MANIFEST="$TMP_MANIFEST" "$SCRIPT" --dry-run
  [ "$status" -eq 1 ]
}

@test "missing manifest fails" {
  run env MANIFEST="$BATS_TEST_TMPDIR/nope.tsv" "$SCRIPT" --dry-run
  [ "$status" -eq 1 ]
}

@test "unknown flag fails with usage" {
  run "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
}

@test "repo manifest dry-run resolves real sources" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"npx skills add vercel-labs/agent-browser -y"* ]]
  [[ "$output" == *"skipped (no recorded source): bgm"* ]]
}
