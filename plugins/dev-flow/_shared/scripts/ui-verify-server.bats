#!/usr/bin/env bats
# ui-verify-server.sh: dev サーバー lifecycle (start/stop) の bats テスト。
# fake dev サーバーとして python3 -m http.server を使う
# (stderr に 'Serving HTTP on ... port N ...' を出すため port parse も検証できる)。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/ui-verify-server.sh"
  REPO="$(mktemp -d)"
  STATE_DIR="$(mktemp -d)"
  cd "$REPO"
  git init -q
  git config user.email t@t
  git config user.name t
  echo "# placeholder" > .gitkeep
  git add .gitkeep && git commit -q -m base

  # 49152-65535 (ephemeral range) からランダムに port を選び衝突を避ける
  PORT=$((49152 + RANDOM % 16000))
}

teardown() {
  # 冪等 stop なので何度呼んでも安全
  bash "$SCRIPT" stop --state-dir "$STATE_DIR" >/dev/null 2>&1 || true
  rm -rf "$REPO" "$STATE_DIR"
}

# -----------------------------------------------------------------------
# 1. start 正常系
# -----------------------------------------------------------------------
@test "1: start 正常系で ok:true, phase:ready, port が返り curl 到達可" {
  run bash "$SCRIPT" start \
    --dir "$REPO" \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR" \
    --timeout 30

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"phase":"ready"'* ]]

  actual_port="$(echo "$output" | jq -r '.port')"
  [ -n "$actual_port" ]
  [ "$actual_port" != "null" ]

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${actual_port}/")"
  [[ "$code" == 2* || "$code" == 3* ]]

  bash "$SCRIPT" stop --state-dir "$STATE_DIR"
}

# -----------------------------------------------------------------------
# 2. stop がプロセスを殺し pid file を消す
# -----------------------------------------------------------------------
@test "2: stop がプロセスを殺し pid file を削除する" {
  run bash "$SCRIPT" start \
    --dir "$REPO" \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR" \
    --timeout 30
  [ "$status" -eq 0 ]

  pid="$(echo "$output" | jq -r '.pid')"
  [ -n "$pid" ]
  [ "$pid" != "null" ]

  [ -f "$STATE_DIR/server.pid" ]

  run bash "$SCRIPT" stop --state-dir "$STATE_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"stopped":true'* ]]

  [ ! -f "$STATE_DIR/server.pid" ]
  ! kill -0 "$pid" 2>/dev/null
}

# -----------------------------------------------------------------------
# 3. stop の冪等性
# -----------------------------------------------------------------------
@test "3: pid file が無い初回 stop も ok:true, stopped:false" {
  run bash "$SCRIPT" stop --state-dir "$STATE_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"stopped":false'* ]]
}

@test "3: stop を連続2回呼んでも2回目は ok:true, stopped:false" {
  run bash "$SCRIPT" start \
    --dir "$REPO" \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR" \
    --timeout 30
  [ "$status" -eq 0 ]

  run bash "$SCRIPT" stop --state-dir "$STATE_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"stopped":true'* ]]

  run bash "$SCRIPT" stop --state-dir "$STATE_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"stopped":false'* ]]
}

# -----------------------------------------------------------------------
# 4. install 失敗
# -----------------------------------------------------------------------
@test "4: install 失敗で ok:false, phase:install, exit 0" {
  run bash "$SCRIPT" start \
    --dir "$REPO" \
    --port "$PORT" \
    --install-cmd "false" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR" \
    --timeout 30

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":false'* ]]
  [[ "$output" == *'"phase":"install"'* ]]
}

# -----------------------------------------------------------------------
# 5. ready timeout: 残留プロセスが無いこと
# -----------------------------------------------------------------------
@test "5: ready timeout で ok:false, phase:ready かつ sleep プロセスが残留しない" {
  run bash "$SCRIPT" start \
    --dir "$REPO" \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "sleep 300" \
    --state-dir "$STATE_DIR" \
    --timeout 3

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":false'* ]]
  [[ "$output" == *'"phase":"ready"'* ]]

  # timeout 後に script 自身が kill するため pid file は残らない
  [ ! -f "$STATE_DIR/server.pid" ]

  # sleep 300 プロセスが残留していないこと
  run pgrep -f "sleep 300"
  [ "$status" -ne 0 ]
}

# -----------------------------------------------------------------------
# 6. usage error
# -----------------------------------------------------------------------
@test "6: --dir 欠落は exit 2" {
  run bash "$SCRIPT" start \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR"

  [ "$status" -eq 2 ]
}

@test "6: 未知の subcommand は exit 2" {
  run bash "$SCRIPT" bogus --state-dir "$STATE_DIR"
  [ "$status" -eq 2 ]
}

# -----------------------------------------------------------------------
# 7. env-file: secret 混入防止 (issue #285 PR #286 review)
# -----------------------------------------------------------------------
@test "7: env-file が worktree で gitignore されていなければ copy を拒否する" {
  local main_repo wt
  main_repo="$(mktemp -d)"
  git -C "$main_repo" init -q
  git -C "$main_repo" config user.email t@t
  git -C "$main_repo" config user.name t
  echo "# placeholder" > "$main_repo/.gitkeep"
  git -C "$main_repo" add .gitkeep
  git -C "$main_repo" commit -q -m base
  # .gitignore に記載していない = 非 ignored な secret ファイル
  echo "SECRET=1" > "$main_repo/.env.local"

  wt="$(mktemp -d)"
  rmdir "$wt"
  git -C "$main_repo" worktree add -q -b "wt-branch-7-$$" "$wt" >/dev/null 2>&1

  run bash "$SCRIPT" start \
    --dir "$wt" \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR" \
    --env-file ".env.local" \
    --timeout 30

  [ "$status" -eq 0 ]
  # 非 ignored なので copy されていないこと
  [ ! -f "$wt/.env.local" ]

  bash "$SCRIPT" stop --state-dir "$STATE_DIR" >/dev/null 2>&1 || true
  git -C "$main_repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$main_repo" "$wt"
}

@test "8: env-file が gitignore されていれば copy され stop で削除される" {
  local main_repo wt
  main_repo="$(mktemp -d)"
  git -C "$main_repo" init -q
  git -C "$main_repo" config user.email t@t
  git -C "$main_repo" config user.name t
  echo ".env.local" > "$main_repo/.gitignore"
  git -C "$main_repo" add .gitignore
  git -C "$main_repo" commit -q -m base
  echo "SECRET=1" > "$main_repo/.env.local"

  wt="$(mktemp -d)"
  rmdir "$wt"
  git -C "$main_repo" worktree add -q -b "wt-branch-8-$$" "$wt" >/dev/null 2>&1

  run bash "$SCRIPT" start \
    --dir "$wt" \
    --port "$PORT" \
    --install-cmd "true" \
    --dev-cmd "python3 -m http.server {port} --bind 127.0.0.1" \
    --state-dir "$STATE_DIR" \
    --env-file ".env.local" \
    --timeout 30

  [ "$status" -eq 0 ]
  # ignored なので copy されているはず
  [ -f "$wt/.env.local" ]

  run bash "$SCRIPT" stop --state-dir "$STATE_DIR"
  [ "$status" -eq 0 ]
  # stop がコピー済み env file を削除する
  [ ! -f "$wt/.env.local" ]

  git -C "$main_repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$main_repo" "$wt"
}
