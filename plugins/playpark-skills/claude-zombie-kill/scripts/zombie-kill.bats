#!/usr/bin/env bats
# zombie-kill.sh のテスト。ps は PATH 先頭の偽物、kill / sleep は export した関数で置き換え、kill の呼び出しを記録する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/zombie-kill.sh"
  WORK="$BATS_TEST_TMPDIR"
  mkdir -p "$WORK/bin"

  # 偽 ps: ps aux 形式で前日以前に起動した claude を 2 件返す。ps -o etime= には 3 日経過を返す
  cat > "$WORK/bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-o" ]; then echo "3-01:00:00"; exit 0; fi
echo "USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND"
echo "me       11111   0.0  0.1   100000   2000 s001  S    Thu06AM   0:01.00 claude --resume"
echo "me       22222   0.0  0.1   100000   2000 s002  S    Wed04PM   0:02.00 claude"
EOF
  chmod +x "$WORK/bin/ps"
  export PATH="$WORK/bin:$PATH"

  export KILL_LOG="$WORK/kill.log"
  : > "$KILL_LOG"
  # 偽 kill: 呼び出しを記録する。STUBBORN_PIDS に含まれる PID は SIGTERM 後も kill -0 で生存を返す
  kill() {
    echo "$*" >> "$KILL_LOG"
    if [ "$1" = "-0" ]; then
      case " ${STUBBORN_PIDS:-} " in *" $2 "*) return 0 ;; *) return 1 ;; esac
    fi
    return 0
  }
  sleep() { :; }
  export -f kill sleep

  unset ZOMBIE_KILL_AUTO
  PLUGIN_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  HOOK_CMD=$(jq -r '.hooks.SessionStart[] | select(.matcher=="startup") | .hooks[0].command' "$PLUGIN_ROOT/hooks/hooks.json")
}

# hooks.json の SessionStart command を Claude Code と同じく bash -c で実行する
run_hook_cmd() {
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$HOOK_CMD" < /dev/null
}

@test "SessionStart hook は既定（opt-in なし）で kill を呼ばず、検出を報告するだけで終わる" {
  run run_hook_cmd
  [ "$status" -eq 0 ]
  [ ! -s "$KILL_LOG" ]
  [[ "$output" == *"PID 11111"* ]]
  [[ "$output" == *"PID 22222"* ]]
  [[ "$output" == *"ZOMBIE_KILL_AUTO=1"* ]]
}

@test "SessionStart hook は ZOMBIE_KILL_AUTO=1 のときだけ kill する" {
  export ZOMBIE_KILL_AUTO=1
  run run_hook_cmd
  [ "$status" -eq 0 ]
  grep -qx "11111" "$KILL_LOG"
  grep -qx "22222" "$KILL_LOG"
  [[ "$output" == *"Done: 2 killed, 0 force-killed."* ]]
}

@test "zombie 候補 2 件の全件に SIGTERM を送り、集計を表示する" {
  run bash "$SCRIPT" --force
  [ "$status" -eq 0 ]
  grep -qx "11111" "$KILL_LOG"
  grep -qx "22222" "$KILL_LOG"
  [[ "$output" == *"Done: 2 killed, 0 force-killed."* ]]
}

@test "SIGTERM に応答しない PID に SIGKILL を送り、force-killed に数える" {
  export STUBBORN_PIDS="22222"
  run bash "$SCRIPT" --force
  [ "$status" -eq 0 ]
  grep -qx -- "-9 22222" "$KILL_LOG"
  [[ "$output" == *"Done: 2 killed, 1 force-killed."* ]]
}
