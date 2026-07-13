#!/usr/bin/env bash
# install-schedule.sh - dev-flow-improve の週次 launchd ジョブ登録（macOS）
#
# 毎週土曜 01:00（ローカル時刻）に `claude -p "/dev-flow-improve"` を skills リポジトリの
# root で headless 実行する LaunchAgent を登録する。
#
# Usage:
#   install-schedule.sh --print       # plist を stdout に出力（登録しない・CI/テスト用）
#   install-schedule.sh --install     # ~/Library/LaunchAgents へ書き込み + bootstrap
#   install-schedule.sh --uninstall   # bootout + plist 削除
set -euo pipefail

LABEL="com.playpark.dev-flow-improve"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.claude/logs"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

print_plist() {
  local claude_bin
  claude_bin="$(command -v claude || true)"
  if [[ -z "$claude_bin" ]]; then
    echo "error: claude CLI が PATH に見つかりません" >&2
    return 1
  fi
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${claude_bin}</string>
    <string>-p</string>
    <string>/dev-flow-improve</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>6</integer>
    <key>Hour</key><integer>1</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/dev-flow-improve.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/dev-flow-improve.err.log</string>
</dict>
</plist>
PLIST
}

case "${1:-}" in
  --print)
    print_plist
    ;;
  --install)
    mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR"
    print_plist > "$PLIST_PATH"
    launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
    echo "installed: $PLIST_PATH"
    ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "uninstalled: $PLIST_PATH"
    ;;
  *)
    echo "Usage: install-schedule.sh --print|--install|--uninstall" >&2
    exit 1
    ;;
esac
