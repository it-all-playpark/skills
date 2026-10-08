#!/usr/bin/env bats
# detect-test-runner.sh: repo に既にある設定ファイルからテストランナーを判定し、受理パターン(runners[].accept)と
# 単体実行コマンド(runners[].command / 引数ファイルの commands[].argv)を返す。ランナー別の fixture repo で pin する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/detect-test-runner.sh"
  REPO="$(mktemp -d)"
}
teardown() { rm -rf "$REPO"; }

# detect <jq filter> <files...>: 判定結果に jq を掛ける
detect() {
  local filter="$1"; shift
  bash "$SCRIPT" "$REPO" "$@" | jq -c "$filter"
}

JS_ACCEPT='["*.test.{js,jsx,mjs,cjs,ts,tsx,mts,cts}","*.spec.{js,jsx,mjs,cjs,ts,tsx,mts,cts}","__tests__/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"]'

@test "vitest: vitest.config.* の repo は vitest(lockfile 無しは npx)で *.test.* / *.spec.* / __tests__/ を受理する" {
  echo '{}' > "$REPO/package.json"
  echo 'export default {}' > "$REPO/vitest.config.ts"

  [ "$(detect '.runners[0] | [.runner, .command]')" = '["vitest","npx vitest run <files>"]' ]
  [ "$(detect '.runners[0].accept')" = "$JS_ACCEPT" ]
  [ "$(detect '.commands' a.test.ts src/b.spec.tsx src/__tests__/c.js)" = '[{"runner":"vitest","argv":["npx","vitest","run","a.test.ts","src/b.spec.tsx","src/__tests__/c.js"]}]' ]
}

@test "vitest: deps の vitest でも判定し、pnpm-lock.yaml の repo は pnpm exec で起動する" {
  echo '{"devDependencies":{"vitest":"^3.0.0"}}' > "$REPO/package.json"
  : > "$REPO/pnpm-lock.yaml"

  [ "$(detect '.runners[0].command')" = '"pnpm exec vitest run <files>"' ]
  [ "$(detect '.commands[0].argv' a.test.mjs)" = '["pnpm","exec","vitest","run","a.test.mjs"]' ]
}

@test "jest: deps の jest / jest.config.* / package.json の jest キーで jest を判定する(yarn.lock は yarn 起動)" {
  echo '{"devDependencies":{"jest":"^29.0.0"}}' > "$REPO/package.json"
  [ "$(detect '.runners[0] | [.runner, .command]')" = '["jest","npx jest <files>"]' ]
  [ "$(detect '.commands' a.test.ts)" = '[{"runner":"jest","argv":["npx","jest","a.test.ts"]}]' ]

  echo '{}' > "$REPO/package.json"
  echo 'module.exports = {}' > "$REPO/jest.config.js"
  : > "$REPO/yarn.lock"
  [ "$(detect '.runners[0].command')" = '"yarn jest <files>"' ]

  rm "$REPO/jest.config.js"
  echo '{"jest":{"testEnvironment":"node"}}' > "$REPO/package.json"
  [ "$(detect '.runners[0].runner')" = '"jest"' ]
}

@test "node: scripts.test が node --test の repo は node --test で起動する" {
  echo '{"scripts":{"test":"node --test"}}' > "$REPO/package.json"

  [ "$(detect '.runners[0] | [.runner, .command]')" = '["node","node --test <files>"]' ]
  [ "$(detect '.runners[0].accept')" = "$JS_ACCEPT" ]
  [ "$(detect '.commands' lib/a.test.mjs)" = '[{"runner":"node","argv":["node","--test","lib/a.test.mjs"]}]' ]
}

@test "JS: playwright.config.* の repo は *.spec.* を受理しない" {
  echo '{"devDependencies":{"vitest":"^3.0.0"}}' > "$REPO/package.json"
  echo 'export default {}' > "$REPO/playwright.config.ts"

  [ "$(detect '.runners[0].accept')" = '["*.test.{js,jsx,mjs,cjs,ts,tsx,mts,cts}","__tests__/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"]' ]
  [ "$(detect '[.files[].runner]' e2e/login.spec.ts a.test.ts)" = '[null,"vitest"]' ]
}

@test "pytest(素): pytest.ini の repo は test_*.py / *_test.py を pytest で起動する" {
  printf '[pytest]\n' > "$REPO/pytest.ini"

  [ "$(detect '.runners[0] | [.runner, .accept, .command]')" = '["pytest",["test_*.py","*_test.py"],"pytest <files>"]' ]
  [ "$(detect '.commands' tests/test_a.py b_test.py)" = '[{"runner":"pytest","argv":["pytest","tests/test_a.py","b_test.py"]}]' ]
  [ "$(detect '[.files[].runner]' helper.py)" = '[null]' ]
}

@test "pytest(uv): pyproject.toml [tool.pytest.ini_options] + uv.lock は uv run pytest" {
  printf '[tool.pytest.ini_options]\naddopts = "-q"\n' > "$REPO/pyproject.toml"
  : > "$REPO/uv.lock"

  [ "$(detect '.runners[0].command')" = '"uv run pytest <files>"' ]
  [ "$(detect '.commands[0].argv' test_a.py)" = '["uv","run","pytest","test_a.py"]' ]
}

@test "pytest(poetry): conftest.py + poetry.lock は poetry run pytest" {
  : > "$REPO/conftest.py"
  : > "$REPO/poetry.lock"

  [ "$(detect '.runners[0].command')" = '"poetry run pytest <files>"' ]
  [ "$(detect '.commands[0].argv' test_a.py)" = '["poetry","run","pytest","test_a.py"]' ]
}

@test "go: go.mod の repo は *_test.go をパッケージ単位の go test ./<dir> で起動する" {
  printf 'module example.com/fx\n' > "$REPO/go.mod"

  [ "$(detect '.runners[0] | [.runner, .accept, .command]')" = '["go",["*_test.go"],"go test ./<dir>"]' ]
  [ "$(detect '.commands' pkg/a_test.go pkg/b_test.go root_test.go)" = '[{"runner":"go","argv":["go","test","./pkg"]},{"runner":"go","argv":["go","test","."]}]' ]
}

@test "cargo: Cargo.toml の repo は tests/<stem>.rs を cargo test --test <stem> で起動し、src/ の inline テストは受理しない" {
  printf '[package]\nname = "fx"\n' > "$REPO/Cargo.toml"

  [ "$(detect '.runners[0] | [.runner, .accept, .command]')" = '["cargo",["tests/*.rs"],"cargo test --test <stem>"]' ]
  [ "$(detect '.commands' tests/foo.rs)" = '[{"runner":"cargo","argv":["cargo","test","--test","foo"]}]' ]
  [ "$(detect '[.files[].runner]' src/lib.rs tests/common/mod.rs)" = '[null,null]' ]
}

@test "bats: 設定の無い repo でも *.bats は bats で起動する" {
  [ "$(detect '.runners')" = '[{"runner":"bats","accept":["*.bats"],"exclude":[],"command":"bats <files>"}]' ]
  [ "$(detect '.commands' a.bats scripts/b.bats)" = '[{"runner":"bats","argv":["bats","a.bats","scripts/b.bats"]}]' ]
}

@test "未検出: ランナーの判定元が無い repo の JS / Python / Go / Rust のファイルは runner:null でコマンドに入らない" {
  run bash "$SCRIPT" "$REPO" a.test.ts test_a.py a_test.go tests/a.rs Foo.java
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.runners[].runner]')" = '["bats"]' ]
  [ "$(printf '%s' "$output" | jq -c '[.files[].runner]')" = '[null,null,null,null,null]' ]
  [ "$(printf '%s' "$output" | jq -c '.commands')" = '[]' ]

  # package.json があっても vitest / jest / node --test のどれにも当たらなければ JS も未検出
  echo '{"scripts":{"test":"mocha"}}' > "$REPO/package.json"
  [ "$(detect '[.runners[].runner]')" = '["bats"]' ]
  [ "$(detect '[.files[].runner]' a.test.js)" = '[null]' ]
}

@test "複数エコシステムの repo はランナーを JS / pytest / go / cargo / bats の順に並べ、ファイルごとに振り分ける" {
  echo '{"devDependencies":{"vitest":"^3.0.0"}}' > "$REPO/package.json"
  printf '[pytest]\n' > "$REPO/pytest.ini"
  printf 'module example.com/fx\n' > "$REPO/go.mod"
  printf '[package]\nname = "fx"\n' > "$REPO/Cargo.toml"

  [ "$(detect '[.runners[].runner]')" = '["vitest","pytest","go","cargo","bats"]' ]
  [ "$(detect '[.commands[].runner]' x.bats tests/r.rs a_test.go test_p.py a.test.ts)" = '["vitest","pytest","go","cargo","bats"]' ]
}

@test "引数不正・repo に入れないときは exit 2" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" "$REPO/nonexistent"
  [ "$status" -eq 2 ]
}
