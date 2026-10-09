#!/usr/bin/env bash
# detect-test-runner.sh - repo に既にある設定ファイルからテストランナーを決定論で判定し、テストファイルの
# 受理パターンと単体実行コマンドを返す。redgreen-verify の受理判定・実行と、prerun が evaluator prompt へ渡す
# 受理パターン(args.setup.stack.test_runners)の唯一の判定元。dev-flow 専用の設定ファイルは読まない。
# Usage: detect-test-runner.sh <repo> [<test file>...]   (test file は <repo> 相対)
#
# 判定(ファイルの拡張子でエコシステムを分け、各エコシステムのランナーは repo に 1 つ):
#   JS     : ランナーは vitest(vitest.config.* / deps の vitest) > jest(jest.config.* / package.json の jest キー /
#            deps の jest) > node(scripts.test が node --test)の順で最初に当たったもの。vitest / jest の起動 prefix は
#            lockfile の PM で決める(detect-and-install.sh の detect_node_pm と同じ順: pnpm-lock.yaml > yarn.lock >
#            bun.lockb > package-lock.json > 無ければ npm)。受理は *.test.<ext> / *.spec.<ext> / __tests__/ 配下
#            (ext は js / jsx / mjs / cjs / ts / tsx / mts / cts)。playwright.config.* がある repo では *.spec.<ext> を
#            受理しない(playwright の対象を unit runner で走らせない)
#   Python : pytest 設定(run-tests.sh のフォールバックと同じ判定) → test_*.py / *_test.py を pytest。
#            uv.lock があれば uv run、poetry.lock があれば poetry run を前置
#   Go     : go.mod → *_test.go をパッケージ単位で go test ./<dir>
#   Rust   : Cargo.toml → repo 直下 tests/ 直下の <stem>.rs を cargo test --test <stem>(src/ の inline テストは受理しない)
#   Ruby   : Gemfile.lock に rspec-core → spec/ 配下の *_spec.rb を bundle exec rspec(rspec)。それ以外で bin/rails が
#            ある → test/ 配下の *_test.rb を bin/rails test(minitest)。bin/rails の無い素の minitest は判定しない
#   PHP    : composer.json の require / require-dev に pestphp/pest → *Test.php を vendor/bin/pest(pest)。それ以外で
#            phpunit/phpunit → vendor/bin/phpunit(phpunit)
#   bats   : *.bats → bats(設定不要。常に受理)
# どれにも当たらないファイルは runner:null(呼び出し側が「ランナー未検出」で拒否する)。
#
# 出力(stdout, JSON 1 行):
#   {"runners":[{"runner":"vitest","accept":[...],"exclude":[...],"command":"npx vitest run <files>"},...],
#    "files":[{"file":"a.test.ts","runner":"vitest"},{"file":"x.rb","runner":null},...],
#    "commands":[{"runner":"vitest","argv":["npx","vitest","run","a.test.ts"]},...]}
# runners は repo で検出したランナー(順: JS / pytest / go / cargo / Ruby / PHP / bats)。files / commands は引数のテストファイル分
# (引数なしなら空配列)。commands は runner:null 以外のファイルを runner ごと(go はパッケージ・cargo は stem ごと)に
# まとめた <repo> を cwd とする argv。exit: 0 / 引数不正・<repo> に入れない・jq 不在は 2。
set -uo pipefail

REPO="${1:-}"
[ -n "$REPO" ] || { echo "usage: detect-test-runner.sh <repo> [<test file>...]" >&2; exit 2; }
shift
cd "$REPO" 2>/dev/null || { echo "cd failed: $REPO" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 2; }

has_glob() {
  local f
  for f in "$@"; do [ -e "$f" ] && return 0; done
  return 1
}

# --- JS ---
JS_RUNNER=""
JS_PREFIX=()
PLAYWRIGHT=false
if [ -f package.json ]; then
  deps="$(jq -r '((.dependencies // {}) + (.devDependencies // {})) | keys[]' package.json 2>/dev/null)"
  if has_glob vitest.config.* || grep -qx 'vitest' <<< "$deps"; then
    JS_RUNNER=vitest
  elif has_glob jest.config.* || jq -e 'has("jest")' package.json >/dev/null 2>&1 || grep -qx 'jest' <<< "$deps"; then
    JS_RUNNER=jest
  elif jq -e '.scripts.test | type == "string" and test("(^|[^[:alnum:]_-])node[[:space:]]+--test")' package.json >/dev/null 2>&1; then
    JS_RUNNER=node
  fi
  if [ -f pnpm-lock.yaml ]; then JS_PREFIX=(pnpm exec)
  elif [ -f yarn.lock ]; then JS_PREFIX=(yarn)
  elif [ -f bun.lockb ]; then JS_PREFIX=(bunx)
  else JS_PREFIX=(npx)
  fi
  has_glob playwright.config.* && PLAYWRIGHT=true
fi
JS_CMD=()
case "$JS_RUNNER" in
  vitest) JS_CMD=("${JS_PREFIX[@]}" vitest run) ;;
  jest) JS_CMD=("${JS_PREFIX[@]}" jest) ;;
  node) JS_CMD=(node --test) ;;
esac

# --- Python(pytest) ---
PYTEST=false
PY_CMD=()
if [ -f pytest.ini ] || [ -f conftest.py ] \
    || grep -qs '^\[tool\.pytest' pyproject.toml \
    || grep -qs '^\[tool:pytest\]' setup.cfg \
    || grep -qs '^\[pytest\]' tox.ini; then
  PYTEST=true
  if [ -f uv.lock ]; then PY_CMD=(uv run pytest)
  elif [ -f poetry.lock ]; then PY_CMD=(poetry run pytest)
  else PY_CMD=(pytest)
  fi
fi

GO=false; [ -f go.mod ] && GO=true
CARGO=false; [ -f Cargo.toml ] && CARGO=true

# --- Ruby(rspec / Rails minitest) ---
RUBY_RUNNER=""
RUBY_CMD=()
if grep -qsE '^[[:space:]]+rspec-core([[:space:]]|$)' Gemfile.lock; then
  RUBY_RUNNER=rspec; RUBY_CMD=(bundle exec rspec)
elif [ -f bin/rails ]; then
  RUBY_RUNNER=minitest; RUBY_CMD=(bin/rails test)
fi

# --- PHP(pest / phpunit) ---
PHP_RUNNER=""
PHP_CMD=()
if [ -f composer.json ]; then
  php_deps="$(jq -r '((.require // {}) + (."require-dev" // {})) | keys[]' composer.json 2>/dev/null)"
  if grep -qx 'pestphp/pest' <<< "$php_deps"; then
    PHP_RUNNER=pest; PHP_CMD=(vendor/bin/pest)
  elif grep -qx 'phpunit/phpunit' <<< "$php_deps"; then
    PHP_RUNNER=phpunit; PHP_CMD=(vendor/bin/phpunit)
  fi
fi

JS_EXT='{js,jsx,mjs,cjs,ts,tsx,mts,cts}'

# ファイル 1 件のランナー名(未検出は空)
runner_of() {
  local f="$1" base="${1##*/}"
  case "$base" in
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts)
      [ -n "$JS_RUNNER" ] || return 0
      case "$base" in
        *.spec.*) [ "$PLAYWRIGHT" = true ] || echo "$JS_RUNNER"; return 0 ;;
        *.test.*) echo "$JS_RUNNER"; return 0 ;;
      esac
      case "/$f" in */__tests__/*) echo "$JS_RUNNER" ;; esac
      ;;
    test_*.py|*_test.py) [ "$PYTEST" = true ] && echo pytest ;;
    *_test.go) [ "$GO" = true ] && echo go ;;
    *.rs)
      if [ "$CARGO" = true ]; then
        case "$f" in tests/*/*) : ;; tests/*.rs) echo cargo ;; esac
      fi
      ;;
    *_spec.rb) [ "$RUBY_RUNNER" = rspec ] && case "$f" in spec/*) echo rspec ;; esac ;;
    *_test.rb) [ "$RUBY_RUNNER" = minitest ] && case "$f" in test/*) echo minitest ;; esac ;;
    *Test.php) [ -n "$PHP_RUNNER" ] && echo "$PHP_RUNNER" ;;
    *.bats) echo bats ;;
  esac
  return 0
}

# --- runners ---
RUNNERS='[]'
add_runner() { # name accept_json exclude_json command
  RUNNERS="$(jq -c --arg r "$1" --argjson a "$2" --argjson e "$3" --arg c "$4" '. + [{runner: $r, accept: $a, exclude: $e, command: $c}]' <<< "$RUNNERS")"
}
if [ -n "$JS_RUNNER" ]; then
  if [ "$PLAYWRIGHT" = true ]; then
    add_runner "$JS_RUNNER" "[\"*.test.$JS_EXT\",\"__tests__/**/*.$JS_EXT\"]" "[\"*.spec.$JS_EXT (playwright)\"]" "${JS_CMD[*]} <files>"
  else
    add_runner "$JS_RUNNER" "[\"*.test.$JS_EXT\",\"*.spec.$JS_EXT\",\"__tests__/**/*.$JS_EXT\"]" '[]' "${JS_CMD[*]} <files>"
  fi
fi
[ "$PYTEST" = true ] && add_runner pytest '["test_*.py","*_test.py"]' '[]' "${PY_CMD[*]} <files>"
[ "$GO" = true ] && add_runner go '["*_test.go"]' '[]' 'go test ./<dir>'
[ "$CARGO" = true ] && add_runner cargo '["tests/*.rs"]' '["src/ の inline テスト"]' 'cargo test --test <stem>'
[ "$RUBY_RUNNER" = rspec ] && add_runner rspec '["spec/**/*_spec.rb"]' '[]' "${RUBY_CMD[*]} <files>"
[ "$RUBY_RUNNER" = minitest ] && add_runner minitest '["test/**/*_test.rb"]' '[]' "${RUBY_CMD[*]} <files>"
[ -n "$PHP_RUNNER" ] && add_runner "$PHP_RUNNER" '["*Test.php"]' '[]' "${PHP_CMD[*]} <files>"
add_runner bats '["*.bats"]' '[]' 'bats <files>'

# --- files / commands ---
FILES='[]'
JS_FILES=(); PY_FILES=(); RUBY_FILES=(); PHP_FILES=(); BATS_FILES=(); GO_DIRS=(); CARGO_STEMS=()
contains() { # needle haystack...
  local n="$1" x; shift
  for x in "$@"; do [ "$x" = "$n" ] && return 0; done
  return 1
}
for f in "$@"; do
  r="$(runner_of "$f")"
  FILES="$(jq -c --arg f "$f" --arg r "$r" '. + [{file: $f, runner: (if $r == "" then null else $r end)}]' <<< "$FILES")"
  case "$r" in
    vitest|jest|node) JS_FILES+=("$f") ;;
    pytest) PY_FILES+=("$f") ;;
    rspec|minitest) RUBY_FILES+=("$f") ;;
    pest|phpunit) PHP_FILES+=("$f") ;;
    bats) BATS_FILES+=("$f") ;;
    go)
      d="$(dirname "$f")"
      if [ "$d" = . ]; then d=.; else d="./${d#./}"; fi
      contains "$d" ${GO_DIRS[@]+"${GO_DIRS[@]}"} || GO_DIRS+=("$d")
      ;;
    cargo)
      s="${f##*/}"; s="${s%.rs}"
      contains "$s" ${CARGO_STEMS[@]+"${CARGO_STEMS[@]}"} || CARGO_STEMS+=("$s")
      ;;
  esac
done

COMMANDS='[]'
add_command() { # runner argv...(argv は 1 行 1 要素で jq に渡す。--args は --test 等を jq の option と読む)
  local r="$1" argv; shift
  argv="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
  COMMANDS="$(jq -c --arg r "$r" --argjson a "$argv" '. + [{runner: $r, argv: $a}]' <<< "$COMMANDS")"
}
[ "${#JS_FILES[@]}" -gt 0 ] && add_command "$JS_RUNNER" "${JS_CMD[@]}" "${JS_FILES[@]}"
[ "${#PY_FILES[@]}" -gt 0 ] && add_command pytest "${PY_CMD[@]}" "${PY_FILES[@]}"
for d in ${GO_DIRS[@]+"${GO_DIRS[@]}"}; do add_command go go test "$d"; done
for s in ${CARGO_STEMS[@]+"${CARGO_STEMS[@]}"}; do add_command cargo cargo test --test "$s"; done
[ "${#RUBY_FILES[@]}" -gt 0 ] && add_command "$RUBY_RUNNER" "${RUBY_CMD[@]}" "${RUBY_FILES[@]}"
[ "${#PHP_FILES[@]}" -gt 0 ] && add_command "$PHP_RUNNER" "${PHP_CMD[@]}" "${PHP_FILES[@]}"
[ "${#BATS_FILES[@]}" -gt 0 ] && add_command bats bats "${BATS_FILES[@]}"

jq -nc --argjson r "$RUNNERS" --argjson f "$FILES" --argjson c "$COMMANDS" '{runners: $r, files: $f, commands: $c}'
