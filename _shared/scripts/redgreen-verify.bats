#!/usr/bin/env bats
# redgreen-verify.sh: impl を退避して test が red→green に転じるか判定する。
# untracked 新規ファイル・tracked-modified ファイルの両シナリオをカバーする。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/redgreen-verify.sh"
  REPO="$(mktemp -d)"
  cd "$REPO"
  git init -q && git config user.email t@t && git config user.name t
  # base commit(空でも良いが git stash が機能するためダミーを入れる)
  echo "# placeholder" > .gitkeep
  git add .gitkeep && git commit -q -m base
}
teardown() { rm -rf "$REPO"; }

# --- helper: feature.test.mjs を生成 ---
make_test() {
  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './impl.mjs';
test('ok is true', () => { assert.equal(ok, true); });
EOF
}

# -----------------------------------------------------------------------
# シナリオ A: tracked-modified (従来パス)
# impl を base で commit → worktree 上で変更 → untracked ではない
# -----------------------------------------------------------------------
@test "A: tracked-modified impl で red→green 判定が成立する" {
  # base commit に impl(false)を含める
  echo "export const ok = false;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl base"
  # worktree 上で true に変更(tracked-modified = implementer の変更相当)
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
}

# -----------------------------------------------------------------------
# シナリオ B: untracked 新規 impl (dev-flow の主要ユースケース)
# impl を一度も commit せず worktree に置く → git ls-files で認識されない
# -----------------------------------------------------------------------
@test "B: untracked 新規 impl ファイルで red→green 判定が成立する" {
  # impl を commit しない(untracked のまま)
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
}

@test "B: untracked impl 退避後に worktree に impl が復元されている" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  # 判定後も impl が worktree に残っていること(worktree 破損なし)
  [ -f "$REPO/impl.mjs" ]
  grep -q "true" "$REPO/impl.mjs"
}

# -----------------------------------------------------------------------
# シナリオ C: untracked impl が存在しない(パス誤り)→ exit 2
# -----------------------------------------------------------------------
@test "C: 存在しない untracked impl は exit 2" {
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "nonexistent.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found'* ]]
}

# -----------------------------------------------------------------------
# 既存バリデーション
# -----------------------------------------------------------------------
@test "非 test ファイル申告は exit 2(昇格拒否)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  run bash "$SCRIPT" "$REPO" "impl.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'non-test file'* ]]
}

@test "test と impl が同一ファイル(混在)は exit 2" {
  make_test
  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "feature.test.mjs"
  [ "$status" -eq 2 ]
}

# -----------------------------------------------------------------------
# シナリオ D: 別ディレクトリに同名 untracked impl が複数ある
# a/mod.mjs と b/mod.mjs を同時申告しても basename 衝突で上書きされないこと
# -----------------------------------------------------------------------
@test "D: 別ディレクトリの同名 untracked impl 2 件が両方正しく復元される" {
  mkdir -p "$REPO/a" "$REPO/b"
  echo "export const va = 1;" > "$REPO/a/mod.mjs"
  echo "export const vb = 2;" > "$REPO/b/mod.mjs"

  # test ファイル(参照しないが runner が必要)
  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('dummy', () => { assert.ok(true); });
EOF

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "a/mod.mjs,b/mod.mjs"
  [ "$status" -eq 0 ]

  # 両ファイルが正しい内容で復元されていること
  [ -f "$REPO/a/mod.mjs" ]
  grep -q "va = 1" "$REPO/a/mod.mjs"
  [ -f "$REPO/b/mod.mjs" ]
  grep -q "vb = 2" "$REPO/b/mod.mjs"
}

# -----------------------------------------------------------------------
# シナリオ E: 複数 untracked impl の一部が不在 → 先行ファイルが消失しないこと
# first.mjs は存在、second.mjs は不在 → exit 2 かつ first.mjs が復元されている
# -----------------------------------------------------------------------
@test "E: 複数 untracked impl の一部が不在のとき先行ファイルが消失しない" {
  echo "export const ok = true;" > "$REPO/first.mjs"
  # second.mjs は意図的に作らない

  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('dummy', () => { assert.ok(true); });
EOF

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "first.mjs,second.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found'* ]]

  # first.mjs が削除されずに残っている(消失しない)
  [ -f "$REPO/first.mjs" ]
  grep -q "true" "$REPO/first.mjs"
}

# -----------------------------------------------------------------------
# F1: opt-in test_cmd / verdict_cmd mechanism (.claude/redgreen.conf)
# -----------------------------------------------------------------------

make_mock_runner() {
  cat > "$REPO/mock-runner.sh" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$REPO/calls.log"
[ -f "$REPO/impl.mjs" ]
EOF
  chmod +x "$REPO/mock-runner.sh"
}

@test "F1-a: opt-in test_cmd runs mock runner twice (red + green) with declared test file" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  make_mock_runner
  mkdir -p "$REPO/.claude"
  echo "test_cmd=bash ./mock-runner.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]

  [ -f "$REPO/calls.log" ]
  call_count="$(grep -c 'feature.test.mjs' "$REPO/calls.log")"
  [ "$call_count" -eq 2 ]
}

@test "F1-b: conf without test_cmd line falls back to node --test unchanged" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  mkdir -p "$REPO/.claude"
  echo "# no test_cmd here" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ ! -f "$REPO/calls.log" ]
}

@test "F1-c: verdict_cmd success adds verdict field to output JSON" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"comparability":"exact","verdict":"improved"}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  echo "verdict_cmd=bash ./mock-verdict.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" == *'"reason":"ok"'* ]]
  [[ "$output" == *'"verdict"'* ]]
  [[ "$output" == *'"comparability":"exact"'* ]]
}

@test "F1-d: verdict_cmd exit 1 fails open, output keeps only the original 3 keys" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$REPO/mock-verdict.sh"
  echo "verdict_cmd=bash ./mock-verdict.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" != *'"verdict"'* ]]
}

@test "F1-e: verdict_cmd invalid JSON fails open, output keeps only the original 3 keys" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo "not-json"
EOF
  chmod +x "$REPO/mock-verdict.sh"
  echo "verdict_cmd=bash ./mock-verdict.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" != *'"verdict"'* ]]
}
