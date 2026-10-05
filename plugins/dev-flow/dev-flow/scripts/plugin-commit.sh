#!/usr/bin/env bash
# plugin-commit.sh - dev-flow plugin の配置元 commit（skills repo の commit SHA 先頭 12 桁）を返す (issue #785)
#
# Usage: bash plugin-commit.sh <plugin-root>
#
# 出力: 12 桁 hex を stdout に 1 行。決められなければ何も出さない。常に exit 0。
#
# prerun.sh が telemetry キー plugin_commit の給電元として呼ぶ。workflow script は plugin root
# 変数も fs も使えないので、シェルで動く prerun が決めて args.setup.plugin_commit で渡す。
#   - cache mode（marketplace install）: plugin root のディレクトリ名が commit SHA の先頭 12 桁
#     （例: ~/.claude/plugins/cache/playpark/dev-flow/1ef2e0ab6254）
#   - link mode（repo checkout）: plugin root を含む checkout の HEAD の先頭 12 桁。cache mode の
#     ディレクトリ名と同じ桁数に揃えるため --short ではなく全桁から切り出す（--short は曖昧さ回避で伸びうる）
# 記録専用の値なので失敗は空出力に倒す（fail-open）。dev-flow の実行を止めない。

set -uo pipefail

root="${1:-}"
[[ -n "$root" && -d "$root" ]] || exit 0

name="$(basename "$root")"
if [[ "$name" =~ ^[0-9a-f]{12}$ ]]; then
    printf '%s\n' "$name"
    exit 0
fi

sha="$(git -C "$root" rev-parse --verify --quiet HEAD 2>/dev/null)" || exit 0
if [[ "$sha" =~ ^[0-9a-f]{40,64}$ ]]; then
    printf '%s\n' "${sha:0:12}"
fi
exit 0
