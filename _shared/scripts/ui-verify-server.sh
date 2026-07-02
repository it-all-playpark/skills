#!/usr/bin/env bash
# ui-verify-server.sh - dev サーバー lifecycle 管理 (issue #285 F4)
#
# Purpose: dev-flow Evaluate phase 直前で ui-verify 用の dev サーバーを起動/停止する。
# non-blocking / fail-open contract:
#   - start の各段階(install / server 起動 / ready 待ち)の失敗は exit 0 + {"ok":false,...}
#   - usage error(必須引数欠落・未知の subcommand)のみ exit 2
#   - stop は常に exit 0 かつ冪等(pid file が無ければ no-op)
#
# Usage:
#   ui-verify-server.sh start --dir <abs> --port <n> --install-cmd <cmd> --dev-cmd <cmd> \
#       --state-dir <abs> [--ready-path <path=/>] [--timeout <sec=120>] [--env-file <relpath>]...
#   ui-verify-server.sh stop --state-dir <abs>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# subcommand
# ============================================================================

SUBCOMMAND="${1:-}"
[[ -n "$SUBCOMMAND" ]] || { echo "subcommand (start|stop) required" >&2; exit 2; }
shift || true

case "$SUBCOMMAND" in
    start|stop) : ;;
    *) echo "Unknown subcommand: $SUBCOMMAND" >&2; exit 2 ;;
esac

# ============================================================================
# Args
# ============================================================================

DIR=""
PORT=""
INSTALL_CMD=""
DEV_CMD=""
STATE_DIR=""
READY_PATH="/"
TIMEOUT=120
ENV_FILES=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir) DIR="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --install-cmd) INSTALL_CMD="$2"; shift 2 ;;
        --dev-cmd) DEV_CMD="$2"; shift 2 ;;
        --state-dir) STATE_DIR="$2"; shift 2 ;;
        --ready-path) READY_PATH="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --env-file) ENV_FILES+=("$2"); shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

[[ -n "$STATE_DIR" ]] || { echo "--state-dir is required" >&2; exit 2; }

# ============================================================================
# stop (冪等・常に exit 0)
# macOS に setsid が無く process group kill ができないため、
# pkill -TERM -P <pid>(子) + kill -TERM <pid>(親) の親子 kill 方式を取る。
# ============================================================================

do_stop() {
    local pid_file="$STATE_DIR/server.pid"

    if [[ ! -f "$pid_file" ]]; then
        echo '{"ok":true,"stopped":false}'
        exit 0
    fi

    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    rm -f "$pid_file"

    if [[ -z "$pid" ]]; then
        echo '{"ok":true,"stopped":false}'
        exit 0
    fi

    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true

    local waited=0
    while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 5 ]]; do
        sleep 1
        waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -KILL "$pid" 2>/dev/null || true
    fi

    echo '{"ok":true,"stopped":true}'
    exit 0
}

if [[ "$SUBCOMMAND" == "stop" ]]; then
    do_stop
fi

# ============================================================================
# start
# ============================================================================

[[ -n "$DIR" ]] || { echo "--dir is required" >&2; exit 2; }
[[ -n "$PORT" ]] || { echo "--port is required" >&2; exit 2; }
[[ -n "$INSTALL_CMD" ]] || { echo "--install-cmd is required" >&2; exit 2; }
[[ -n "$DEV_CMD" ]] || { echo "--dev-cmd is required" >&2; exit 2; }

mkdir -p "$STATE_DIR"

INSTALL_LOG="$STATE_DIR/install.log"
SERVER_LOG="$STATE_DIR/server.log"
PID_FILE="$STATE_DIR/server.pid"

# ----------------------------------------------------------------------------
# env files: main repo root(worktree 共通の git-common-dir 親)から <dir>/<relpath>
# へコピーする。存在しないファイルは warning のみで続行(best-effort)。
# ----------------------------------------------------------------------------
if [[ ${#ENV_FILES[@]} -gt 0 ]]; then
    main_repo_root=""
    git_common_dir="$(git -C "$DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -n "$git_common_dir" ]]; then
        main_repo_root="$(cd "$(dirname "$git_common_dir")" && pwd)"
    fi

    for relpath in "${ENV_FILES[@]}"; do
        if [[ -z "$main_repo_root" ]]; then
            echo "[ui-verify-server] warning: could not resolve main repo root for env-file $relpath" >&2
            continue
        fi
        src="$main_repo_root/$relpath"
        if [[ -f "$src" ]]; then
            dest="$DIR/$relpath"
            mkdir -p "$(dirname "$dest")"
            cp "$src" "$dest"
        else
            echo "[ui-verify-server] warning: env-file not found: $src" >&2
        fi
    done
fi

# ----------------------------------------------------------------------------
# install
# ----------------------------------------------------------------------------
set +e
( cd "$DIR" && bash -c "$INSTALL_CMD" ) >"$INSTALL_LOG" 2>&1
install_rc=$?
set -e

if [[ $install_rc -ne 0 ]]; then
    printf '{"ok":false,"phase":"install","error":"install_command failed (exit %d)","log":%s}\n' \
        "$install_rc" "$(json_escape "$INSTALL_LOG")"
    exit 0
fi

# ----------------------------------------------------------------------------
# pre-start check: 要求 port が使用中でも warning のみ(dev サーバーの port 自動
# fallback に委ねて続行する)
# ----------------------------------------------------------------------------
if command -v lsof &>/dev/null && lsof -i ":$PORT" -sTCP:LISTEN &>/dev/null; then
    echo "[ui-verify-server] warning: port $PORT already in use, dev server may auto-fallback" >&2
fi

# ----------------------------------------------------------------------------
# dev server 起動(detached)
# ----------------------------------------------------------------------------
resolved_cmd="${DEV_CMD//\{port\}/$PORT}"

set +e
(
    cd "$DIR" || exit 1
    nohup bash -c "exec $resolved_cmd" >"$SERVER_LOG" 2>&1 &
    echo $! >"$PID_FILE"
)
launch_rc=$?
set -e

if [[ $launch_rc -ne 0 ]] || [[ ! -f "$PID_FILE" ]]; then
    printf '{"ok":false,"phase":"start","error":"failed to launch dev server","log":%s}\n' \
        "$(json_escape "$SERVER_LOG")"
    exit 0
fi

pid="$(cat "$PID_FILE")"

# ----------------------------------------------------------------------------
# 実ポート確定: server.log を最大 10 秒 poll し、
# (localhost|127.0.0.1):PORT または port PORT の数値を実ポートとする。
# マッチしなければ要求 port へ fallback(Next.js 等の port 自動 fallback 対応)。
# ----------------------------------------------------------------------------
actual_port="$PORT"
waited=0
while [[ $waited -lt 10 ]]; do
    if [[ -f "$SERVER_LOG" ]]; then
        match="$(grep -oE '(localhost|127\.0\.0\.1):[0-9]+|[Pp]ort:? *[0-9]+' "$SERVER_LOG" 2>/dev/null | head -1 || true)"
        if [[ -n "$match" ]]; then
            parsed="$(echo "$match" | grep -oE '[0-9]+' | tail -1)"
            if [[ -n "$parsed" ]]; then
                actual_port="$parsed"
                break
            fi
        fi
    fi
    sleep 1
    waited=$((waited + 1))
done

# ----------------------------------------------------------------------------
# ready poll: 2 秒間隔で timeout 秒まで curl。2xx/3xx で ready。
# 途中でプロセスが死亡していたら即座に失敗を返す。
# ----------------------------------------------------------------------------
elapsed=0
ready=false
died=false
while [[ $elapsed -lt $TIMEOUT ]]; do
    if ! kill -0 "$pid" 2>/dev/null; then
        died=true
        break
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${actual_port}${READY_PATH}" 2>/dev/null || echo "000")"
    if [[ "$code" =~ ^[23] ]]; then
        ready=true
        break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
done

if [[ "$died" == true ]]; then
    rm -f "$PID_FILE"
    printf '{"ok":false,"phase":"start","error":"dev server exited","log":%s}\n' \
        "$(json_escape "$SERVER_LOG")"
    exit 0
fi

if [[ "$ready" != true ]]; then
    # timeout: leak を防ぐため script 自身が kill してから pid file を削除する。
    # 後続の stop は idempotent no-op になる。
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    w=0
    while kill -0 "$pid" 2>/dev/null && [[ $w -lt 5 ]]; do
        sleep 1
        w=$((w + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    printf '{"ok":false,"phase":"ready","error":"ready timeout after %ss","log":%s}\n' \
        "$TIMEOUT" "$(json_escape "$SERVER_LOG")"
    exit 0
fi

printf '{"ok":true,"phase":"ready","port":%d,"pid":%d,"log":%s}\n' \
    "$actual_port" "$pid" "$(json_escape "$SERVER_LOG")"
exit 0
