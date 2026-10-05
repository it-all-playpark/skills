#!/usr/bin/env bash
# install-schedule.sh - dev-flow ヘルスレポートの日次 launchd ジョブ登録（macOS）
#
# 毎日 07:00（ローカル時刻）に daily.sh を skills リポジトリ内で実行する LaunchAgent を登録する。
# launchd の PATH は最小なので、登録時の PATH を EnvironmentVariables に焼き込む
# （jq / git / claude を daily.sh から解決するため）。
#
# Usage:
#   install-schedule.sh --print       # plist を stdout に出力（登録しない・CI/テスト用）
#   install-schedule.sh --install     # ~/Library/LaunchAgents へ書き込み + bootstrap
#   install-schedule.sh --uninstall   # bootout + plist 削除
set -euo pipefail

LABEL="com.playpark.dev-flow-health"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.claude/logs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

print_plist() {
    if ! command -v claude >/dev/null 2>&1; then
        echo "error: claude CLI が PATH に見つかりません（new / regressed がある日に daily.sh が呼ぶ）" >&2
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
    <string>/bin/bash</string>
    <string>${SCRIPT_DIR}/daily.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${PLUGIN_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/dev-flow-health.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/dev-flow-health.err.log</string>
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
