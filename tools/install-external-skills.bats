#!/usr/bin/env bats

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/install-external-skills.sh"
  TMP_MANIFEST="$BATS_TEST_TMPDIR/manifest.tsv"
}

# $1 = stub dir。呼び出しを $NPX_LOG に記録するだけの fake npx を置く。
make_npx_stub() {
  mkdir -p "$1"
  cat >"$1/npx" <<'EOF'
#!/usr/bin/env bash
echo "npx $*" >>"${NPX_LOG:?}"
EOF
  chmod +x "$1/npx"
}

@test "dry-run prints one per-skill add command per manifest row" {
  printf '# comment\na\towner/repo1\nb\towner/repo1\nc\towner/repo2\n' >"$TMP_MANIFEST"
  run env MANIFEST="$TMP_MANIFEST" "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"npx skills add owner/repo1@a -y"* ]]
  [[ "$output" == *"npx skills add owner/repo1@b -y"* ]]
  [[ "$output" == *"npx skills add owner/repo2@c -y"* ]]
}

@test "manifest without trailing newline still processes last row" {
  printf 'a\towner/repo1\nb\towner/repo2' >"$TMP_MANIFEST"
  run env MANIFEST="$TMP_MANIFEST" "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"npx skills add owner/repo2@b -y"* ]]
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

@test "non-dry-run invokes per-skill npx commands via stub" {
  printf 'a\towner/repo1\nb\towner/repo2\n' >"$TMP_MANIFEST"
  make_npx_stub "$BATS_TEST_TMPDIR/bin"
  local root="$BATS_TEST_TMPDIR/root"
  mkdir -p "$root/.agents/skills/a" "$root/.agents/skills/b"
  export NPX_LOG="$BATS_TEST_TMPDIR/npx.log"
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" MANIFEST="$TMP_MANIFEST" REPO_ROOT="$root" "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'skills add' "$NPX_LOG")" -eq 2 ]
  grep -q 'npx skills add owner/repo1@a -y' "$NPX_LOG"
  grep -q 'npx skills add owner/repo2@b -y' "$NPX_LOG"
}

@test "non-dry-run fails with MISSING when skill dir absent after install" {
  printf 'a\towner/repo1\n' >"$TMP_MANIFEST"
  make_npx_stub "$BATS_TEST_TMPDIR/bin"
  local root="$BATS_TEST_TMPDIR/root"
  mkdir -p "$root/.agents/skills"
  export NPX_LOG="$BATS_TEST_TMPDIR/npx.log"
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" MANIFEST="$TMP_MANIFEST" REPO_ROOT="$root" "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"MISSING after install: a"* ]]
}

@test "repo manifest dry-run resolves real sources" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"npx skills add vercel-labs/agent-browser@agent-browser -y"* ]]
  [[ "$output" == *"skipped (no recorded source): bgm"* ]]
}
