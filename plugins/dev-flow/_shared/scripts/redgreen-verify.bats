#!/usr/bin/env bats
# redgreen-verify.sh: impl を退避して test が red→green に転じるか判定する。
# untracked 新規ファイル・tracked-modified ファイルの両シナリオをカバーする。
# 共有 stash スタックに触れない不変条件(G1/G2/G6)も pin する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/redgreen-verify.sh"
  REPO="$(mktemp -d)"
  cd "$REPO"
  git init -q && git config user.email t@t && git config user.name t
  # base commit(G1/G2 の事前 stash 素材にも使う .gitkeep を含める)
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
  make_mock_runner
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"comparability":"exact","verdict":"improved"}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  {
    echo "test_cmd=bash ./mock-runner.sh"
    echo "verdict_cmd=bash ./mock-verdict.sh"
  } > "$REPO/.claude/redgreen.conf"

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
  make_mock_runner
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$REPO/mock-verdict.sh"
  {
    echo "test_cmd=bash ./mock-runner.sh"
    echo "verdict_cmd=bash ./mock-verdict.sh"
  } > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" != *'"verdict"'* ]]
}

@test "F1-e: verdict_cmd invalid JSON fails open, output keeps only the original 3 keys" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  make_mock_runner
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo "not-json"
EOF
  chmod +x "$REPO/mock-verdict.sh"
  {
    echo "test_cmd=bash ./mock-runner.sh"
    echo "verdict_cmd=bash ./mock-verdict.sh"
  } > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" != *'"verdict"'* ]]
}

# -----------------------------------------------------------------------
# F1-f: AC-3 対応。test_cmd + verdict_cmd の両方が設定され、verdict_cmd が
# veridelta 実形の digest JSON を返す正常応答経路。
# -----------------------------------------------------------------------
@test "F1-f: test_cmd と verdict_cmd の両方設定時、正常応答 verdict が出力に含まれる" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  make_mock_runner
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"comparability":"exact","transitions":{"repaired_with_test_change":[]},"verification_surface":{"status":"intact"}}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  {
    echo "test_cmd=bash ./mock-runner.sh"
    echo "verdict_cmd=bash ./mock-verdict.sh"
  } > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" == *'"verdict"'* ]]
  [[ "$output" == *'"comparability":"exact"'* ]]
  [[ "$output" == *'"intact"'* ]]
}

# -----------------------------------------------------------------------
# F1-g: bats-only AC では test_cmd(vdelta run) 経路が実行されないため
# verdict_cmd も起動されない(guard による抑止)。
# -----------------------------------------------------------------------
@test "F1-g: bats-only AC では verdict_cmd が起動されない" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  # NOTE: heredoc でこの .bats ファイルのソース行頭に "@test" を直書きすると、
  # このファイル(redgreen-verify.bats)自身を静的スキャンする bats のテスト発見
  # ロジックが nested な行まで誤って test 宣言として拾ってしまう
  # (bats: unknown test name エラーで plan count がずれる。bats のバージョンに
  # よっては行頭インデントだけでは回避できない)。printf で1行ずつ書き出し、
  # ソース行が "@test" で始まらないようにして誤検出を避ける。
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' '@test "impl exists" {'
    printf '  [ -f "%s/impl.mjs" ]\n' "$REPO"
    printf '%s\n' '}'
  } > "$REPO/feature.bats"
  make_mock_runner
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<EOF
#!/usr/bin/env bash
touch "$REPO/verdict-called"
echo '{"comparability":"exact"}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  {
    echo "test_cmd=bash ./mock-runner.sh"
    echo "verdict_cmd=bash ./mock-verdict.sh"
  } > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" != *'"verdict"'* ]]
  [ ! -f "$REPO/verdict-called" ]
}

# -----------------------------------------------------------------------
# F1-h: test_cmd 未設定(conf に verdict_cmd のみ)の node test AC では
# node --test fallback で red/green は成立するが verdict_cmd は起動されない。
# -----------------------------------------------------------------------
@test "F1-h: test_cmd 未設定時は node --test fallback でも verdict_cmd が起動されない" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"comparability":"exact"}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  echo "verdict_cmd=bash ./mock-verdict.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" != *'"verdict"'* ]]
}

# -----------------------------------------------------------------------
# G1〜G6: issue #630 AC1〜AC6 の pin。共有 stash スタックへの読み書きを
# 撤廃する実装変更(F2)を先取りして red/green を固定する回帰・仕様テスト。
# -----------------------------------------------------------------------

@test "G1: 事前 stash があっても tracked-modified impl の redgreen が共有 stash スタックに触れない" {
  echo "export const ok = false;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl base"
  # 別セッション相当の stash を 1 本積む(tracked ファイルの削除)。push 後 worktree は HEAD に戻る
  rm "$REPO/.gitkeep"
  git -C "$REPO" stash push -q -m "other-session" -- .gitkeep
  [ -f "$REPO/.gitkeep" ]
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  before_n="$(git -C "$REPO" stash list | wc -l | tr -d ' ')"
  before_sha="$(git -C "$REPO" rev-parse 'stash@{0}')"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(git -C "$REPO" stash list | wc -l | tr -d ' ')" = "$before_n" ]
  [ "$(git -C "$REPO" rev-parse 'stash@{0}')" = "$before_sha" ]
  [ -f "$REPO/.gitkeep" ]
  grep -q "true" "$REPO/impl.mjs"
}

@test "G2: HEAD と同一内容の tracked impl のみは exit 2・no impl changed vs HEAD・テスト未実行・tree 不変" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl"
  rm "$REPO/.gitkeep"
  git -C "$REPO" stash push -q -m "other-session" -- .gitkeep
  make_test
  make_mock_runner
  mkdir -p "$REPO/.claude"
  echo "test_cmd=bash ./mock-runner.sh" > "$REPO/.claude/redgreen.conf"
  before_status="$(git -C "$REPO" status --porcelain)"
  before_n="$(git -C "$REPO" stash list | wc -l | tr -d ' ')"
  before_sha="$(git -C "$REPO" rev-parse 'stash@{0}')"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'"reason":"no impl changed vs HEAD'* ]]
  [ ! -f "$REPO/calls.log" ]
  [ "$(git -C "$REPO" status --porcelain)" = "$before_status" ]
  [ "$(git -C "$REPO" stash list | wc -l | tr -d ' ')" = "$before_n" ]
  [ "$(git -C "$REPO" rev-parse 'stash@{0}')" = "$before_sha" ]
  [ -f "$REPO/.gitkeep" ]
}

@test "G3: 変更あり tracked impl + 無変更 tracked impl の混在で変更ありのみ base 化され tree(mode 含む)が不変" {
  echo "export const ok = false;" > "$REPO/impl.mjs"
  echo "export const other = 1;" > "$REPO/other.mjs"
  git -C "$REPO" add impl.mjs other.mjs && git -C "$REPO" commit -q -m "add impls"
  echo "export const ok = true;" > "$REPO/impl.mjs"
  chmod +x "$REPO/impl.mjs"
  make_test
  before_status="$(git -C "$REPO" status --porcelain)"
  before_summary="$(git -C "$REPO" diff HEAD --summary)"
  [[ "$before_summary" == *"mode change"* ]]

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs,other.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(git -C "$REPO" status --porcelain)" = "$before_status" ]
  [ "$(git -C "$REPO" diff HEAD --summary)" = "$before_summary" ]
  [ -x "$REPO/impl.mjs" ]
  grep -q "other = 1" "$REPO/other.mjs"
}

@test "G4: git add 済み未 commit の新規 impl は untracked と同様に red→green、終了後もファイルと index 登録が残る" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ -f "$REPO/impl.mjs" ]
  grep -q "true" "$REPO/impl.mjs"
  git -C "$REPO" ls-files --error-unmatch impl.mjs
  [ "$(git -C "$REPO" diff --cached --name-only)" = "impl.mjs" ]
}

@test "G5: worktree から削除した tracked impl は exit 2・impl file not found・テスト未実行" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl"
  rm "$REPO/impl.mjs"
  make_test
  make_mock_runner
  mkdir -p "$REPO/.claude"
  echo "test_cmd=bash ./mock-runner.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found: impl.mjs'* ]]
  [ ! -f "$REPO/calls.log" ]
  [ ! -f "$REPO/impl.mjs" ]
}

@test "G5b: 削除済み tracked impl と存在する untracked impl の同時申告で untracked impl が消失しない" {
  echo "export const gone = 1;" > "$REPO/gone.mjs"
  git -C "$REPO" add gone.mjs && git -C "$REPO" commit -q -m "add gone"
  rm "$REPO/gone.mjs"
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs,gone.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found: gone.mjs'* ]]
  [ -f "$REPO/impl.mjs" ]
  grep -q "true" "$REPO/impl.mjs"
}

@test "G6: redgreen-verify.sh のコメント行を除いた行に git stash が出現しない" {
  run bash -c "grep -v '^[[:space:]]*#' '$SCRIPT' | grep -c 'git stash'"
  [ "$output" = "0" ]
}

# -----------------------------------------------------------------------
# H: vitest 系 runner(issue #656)
# *.test.ts / *.test.tsx を層2で受理し、test_cmd 未設定時は npx vitest run、
# test_cmd 設定時は .test.mjs と同じ経路(1回起動)に振り分ける。
# *.spec.ts(playwright)は引き続き exit 2。
# -----------------------------------------------------------------------

make_mock_npx() {
  local impl_name="${1:-impl.ts}"
  mkdir -p "$REPO/mockbin"
  cat > "$REPO/mockbin/npx" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$REPO/vitest-calls.log"
[ "\$1" = vitest ] && [ "\$2" = run ] || exit 99
[ -f "$REPO/$impl_name" ]
EOF
  chmod +x "$REPO/mockbin/npx"
}

make_mock_runner_ts() {
  cat > "$REPO/mock-runner.sh" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$REPO/calls.log"
[ -f "$REPO/impl.ts" ]
EOF
  chmod +x "$REPO/mock-runner.sh"
}

@test "H1: *.test.ts / *.test.tsx が層2で受理され、test_cmd 未設定時は npx vitest run で red→green 判定される" {
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  echo "// component test" > "$REPO/Component.test.tsx"
  make_mock_npx

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts,Component.test.tsx" "impl.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ -f "$REPO/vitest-calls.log" ]
  [ "$(wc -l < "$REPO/vitest-calls.log" | tr -d ' ')" -eq 2 ]
  [ "$(grep -c 'vitest run feature.test.ts Component.test.tsx' "$REPO/vitest-calls.log")" -eq 2 ]
  [ -f "$REPO/impl.ts" ]
  grep -q "true" "$REPO/impl.ts"
}

@test "H2: .test.mjs / .bats / vitest 系が混在した test_files で各 runner に振り分けられる" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' '@test "impl exists" {'
    printf '  [ -f "%s/impl.mjs" ]\n' "$REPO"
    printf '%s\n' '}'
  } > "$REPO/feature.bats"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_npx impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.mjs,feature.bats,feature.test.ts" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ -f "$REPO/vitest-calls.log" ]
  [ "$(wc -l < "$REPO/vitest-calls.log" | tr -d ' ')" -eq 2 ]
  grep -q "feature.test.ts" "$REPO/vitest-calls.log"
  ! grep -q "test.mjs" "$REPO/vitest-calls.log"
  ! grep -q ".bats" "$REPO/vitest-calls.log"
}

@test "H3: *.spec.ts (playwright) は引き続き exit 2" {
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// spec test" > "$REPO/feature.spec.ts"

  run bash "$SCRIPT" "$REPO" "feature.spec.ts" "impl.ts"
  [ "$status" -eq 2 ]
  [[ "$output" == *'non-test file declared: feature.spec.ts'* ]]
}

@test "H4: test_cmd 設定時、vitest 系は test_cmd 経路で実行され VDELTA_TESTCMD_RAN=true で verdict_cmd が起動する" {
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_runner_ts
  make_mock_npx
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<EOF
#!/usr/bin/env bash
touch "$REPO/verdict-called"
echo '{"comparability":"exact"}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  {
    echo "test_cmd=bash ./mock-runner.sh"
    echo "verdict_cmd=bash ./mock-verdict.sh"
  } > "$REPO/.claude/redgreen.conf"

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" == *'"verdict"'* ]]
  [[ "$output" == *'"comparability":"exact"'* ]]
  [ -f "$REPO/verdict-called" ]
  [ -f "$REPO/calls.log" ]
  [ "$(grep -c 'feature.test.ts' "$REPO/calls.log")" -eq 2 ]
  [ ! -f "$REPO/vitest-calls.log" ]
}

@test "H5: test_cmd 設定時、.test.mjs と vitest 系の混在は test_cmd 1 回の起動にまとめられる" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_runner
  mkdir -p "$REPO/.claude"
  echo "test_cmd=bash ./mock-runner.sh" > "$REPO/.claude/redgreen.conf"

  run bash "$SCRIPT" "$REPO" "feature.test.mjs,feature.test.ts" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(grep -c 'feature.test.mjs feature.test.ts' "$REPO/calls.log")" -eq 2 ]
}

@test "H6: test_cmd 未設定時の vitest 系では verdict_cmd が起動されない" {
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_npx
  mkdir -p "$REPO/.claude"
  cat > "$REPO/mock-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"comparability":"exact"}'
EOF
  chmod +x "$REPO/mock-verdict.sh"
  echo "verdict_cmd=bash ./mock-verdict.sh" > "$REPO/.claude/redgreen.conf"

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" != *'"verdict"'* ]]
}
