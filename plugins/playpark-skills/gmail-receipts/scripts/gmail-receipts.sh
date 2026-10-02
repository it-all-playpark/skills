#!/usr/bin/env bash
# gmail-receipts: 共通の GAS (gas/Code.gs) を、各 repo の設定 JSON に書かれた
# アカウントごとの Apps Script プロジェクトへ反映する。
#
# Usage:
#   gmail-receipts.sh list   <config.json>
#   gmail-receipts.sh render <config.json> <target-id> <out-dir>
#   gmail-receipts.sh deploy <config.json> <target-id|all>
#   gmail-receipts.sh create <config.json> <target-id>
#   gmail-receipts.sh logs   <config.json> <target-id|all> [件数]
#
# target 固有のキー:
#   "label": "領収書", "folderId": "<Drive フォルダ ID>", "notifyEmail": "me@example.com"(任意。既定は account)
# 設定 JSON の共通部分・出力・Exit は _shared/scripts/gas-project.sh を参照。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_shared/scripts/gas-project.sh
source "$SCRIPT_DIR/../../_shared/scripts/gas-project.sh"

GAS_SKILL="gmail-receipts"
GAS_DIR="$SCRIPT_DIR/../gas"
PROJECT_TITLE="Gmail領収書のDrive保存"

# label の前後に / があると配下ラベルの判定(name.startsWith(label + '/'))が崩れる
gas_validate() {
  cat <<'JQ'
(if (.label | type) != "string" or (.label | test("^[^/\\s]([^/]*[^/\\s])?(/[^/\\s]([^/]*[^/\\s])?)*$") | not)
   then "\($id): label は空でなく、前後に / や空白の無いラベル名にしてください" else empty end),
(if (.folderId | type) != "string" or (.folderId | test("^[A-Za-z0-9_-]+$") | not)
   then "\($id): folderId には Drive フォルダの ID(URL の folders/ の後ろ)を書いてください" else empty end),
(if has("notifyEmail") and ((.notifyEmail | type) != "string" or (.notifyEmail | test("^[^@\\s]+@[^@\\s]+$") | not))
   then "\($id): notifyEmail はメールアドレスにしてください" else empty end)
JQ
}

gas_config() { echo '{label, folderId, notifyEmail: (.notifyEmail // .account)}'; }
gas_list() { gas_config; }

gas_main "$@"
