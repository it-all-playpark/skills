#!/usr/bin/env bash
# workspace-prebuild.sh - pnpm ワークスペースで、ほかのパッケージが import するビルド成果物
# （git 管理外）をテストの直前にビルドする（issue #754）。
# Usage: workspace-prebuild.sh <worktree>
#
# 対象パッケージ（すべて満たす workspace package）:
#   - ほかの workspace package（root を含む）の dependencies / devDependencies に workspace: で入っている
#   - scripts.build を持つ
#   - main / module / exports が指すパスのいずれかが git 管理外（git check-ignore で ignored）
# 対象を `pnpm --filter <a>... --filter <b>... run build` の 1 コマンドでビルドする（依存の順は pnpm に任せる）。
# pnpm-workspace.yaml の無い repo（pnpm 以外を含む）と対象の無い repo では何もしない。
#
# Setup で 1 回ビルドするだけでは足りない: Implement が依存先のソースを変えるとその時点で成果物が古くなり、
# テストが変更前のコードを読む。そのためテストを実行する経路（Validate / Final reconcile の test#final /
# redgreen-verify の red・green）ごとに毎回呼ぶ。成果物を main checkout から持ち込む方式は、main 側の
# 成果物の古さをそのまま持ち込むので採らない。
#
# 出力（stdout, JSON 1 行。ビルドのログは stderr）:
#   {"status":"skipped","reason":"not_pnpm_workspace"|"no_target_packages","packages":[]}              exit 0
#   {"status":"built","packages":[...],"command":"..."}                                                  exit 0
#   {"status":"failed","packages":[...],"command":"...","reason":"workspace build failed: <pkgs>[ ...]"}  exit 1
# 失敗時、呼び出し側はテストを実行せず reason（ビルド失敗と対象パッケージ名）を失敗理由に残す。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=workspace-packages.sh
source "$SCRIPT_DIR/workspace-packages.sh"

if [[ $# -ne 1 ]]; then
    echo "usage: workspace-prebuild.sh <worktree>" >&2
    exit 2
fi
TARGET_PATH=$(cd "$1" 2>/dev/null && pwd) || { echo "cd failed: $1" >&2; exit 2; }
cd "$TARGET_PATH" || exit 2

skipped() {
    jq -nc --arg r "$1" '{status: "skipped", reason: $r, packages: []}'
    exit 0
}

[[ -f "$TARGET_PATH/pnpm-workspace.yaml" ]] || skipped "not_pnpm_workspace"

PKG_DIRS=$(workspace_pkg_dirs pnpm)

# workspace: で参照されている package 名（自分自身への参照は除く）
CONSUMED=""
while IFS= read -r rel; do
    [[ -n "$rel" && -f "$TARGET_PATH/$rel/package.json" ]] || continue
    CONSUMED+=$(jq -r '(.name // "") as $self
        | [.dependencies, .devDependencies][] | (. // {}) | to_entries[]
        | select((.value | type) == "string" and (.value | startswith("workspace:")) and .key != $self)
        | .key' "$TARGET_PATH/$rel/package.json" 2>/dev/null)$'\n'
done <<< "."$'\n'"$PKG_DIRS"

# main / module / exports のいずれかが git 管理外を指すか。exports の "*" は任意の 1 ファイル名に置き換えて判定する
points_to_ignored() {
    local rel="$1" p paths
    paths=$(jq -r '[.main, .module, .exports] | map(select(. != null) | .. | strings) | .[]' "$TARGET_PATH/$rel/package.json" 2>/dev/null)
    while IFS= read -r p; do
        p="${p#./}"
        [[ -n "$p" ]] || continue
        git check-ignore -q -- "$rel/${p//\*/__workspace_prebuild__}" 2>/dev/null && return 0
    done <<< "$paths"
    return 1
}

TARGETS=()
while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    name=$(jq -r '.name // empty' "$TARGET_PATH/$rel/package.json" 2>/dev/null)
    [[ -n "$name" ]] || continue
    grep -Fxq -- "$name" <<< "$CONSUMED" || continue
    jq -e '.scripts.build | type == "string" and length > 0' "$TARGET_PATH/$rel/package.json" >/dev/null 2>&1 || continue
    points_to_ignored "$rel" || continue
    TARGETS+=("$name")
done <<< "$PKG_DIRS"

[[ ${#TARGETS[@]} -gt 0 ]] || skipped "no_target_packages"

ARGS=()
for name in "${TARGETS[@]}"; do ARGS+=(--filter "${name}..."); done
ARGS+=(run build)
CMD="pnpm ${ARGS[*]}"
PACKAGES_JSON=$(printf '%s\n' "${TARGETS[@]}" | jq -R . | jq -sc .)
NAMES=$(printf '%s\n' "${TARGETS[@]}" | paste -sd, - | sed 's/,/, /g')

failed() {
    jq -nc --argjson p "$PACKAGES_JSON" --arg c "$CMD" --arg r "$1" \
        '{status: "failed", packages: $p, command: $c, reason: $r}'
    exit 1
}

command -v pnpm >/dev/null 2>&1 || failed "workspace build failed: $NAMES (pnpm not found)"
pnpm "${ARGS[@]}" >&2 || failed "workspace build failed: $NAMES"

jq -nc --argjson p "$PACKAGES_JSON" --arg c "$CMD" '{status: "built", packages: $p, command: $c}'
