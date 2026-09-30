# workspace-packages.sh - workspace package の列挙（source 専用。単体では実行しない）
# detect-and-install.sh（node_modules の検査・共有キャッシュ, issue #748）と
# workspace-prebuild.sh（ビルド成果物の事前ビルド, issue #754）が同じ列挙を使う。
# 呼び出し側は $TARGET_PATH（project root の絶対パス）を設定してから関数を呼ぶ。

# Workspace package globs for $pm, one per line (issue #748). pnpm reads the
# `packages:` block list of pnpm-workspace.yaml; npm / yarn / bun read
# package.json `workspaces` (array, or the `{packages: [...]}` object form).
# Leading "./" and trailing "/" are stripped; "!" exclusions are kept.
workspace_patterns() {
    local pm="$1"
    if [[ "$pm" == "pnpm" ]]; then
        [[ -f "$TARGET_PATH/pnpm-workspace.yaml" ]] || return 0
        awk '
            /^packages:[[:space:]]*$/ { inpk = 1; next }
            inpk && /^[^[:space:]#]/ { inpk = 0 }
            inpk && /^[[:space:]]*-[[:space:]]*/ {
                sub(/^[[:space:]]*-[[:space:]]*/, "")
                sub(/[[:space:]]+#.*$/, "")
                gsub(/["\047]/, "")
                sub(/[[:space:]]+$/, "")
                if ($0 != "") print
            }
        ' "$TARGET_PATH/pnpm-workspace.yaml" 2>/dev/null || true
    else
        [[ -f "$TARGET_PATH/package.json" ]] || return 0
        jq -r '(.workspaces // []) | (if type == "object" then (.packages // []) else . end) | .[]? | strings' \
            "$TARGET_PATH/package.json" 2>/dev/null || true
    fi | sed -e 's#^\(!\{0,1\}\)\./#\1#' -e 's#/$##'
}

# Whether workspace-relative dir $1 matches glob $2. `*` stays within one
# path segment and `**` spans any depth: bash [[ == ]] lets `*` cross "/",
# so a pattern without `**` must also have the same segment count.
workspace_glob_match() {
    local rel="$1" pat="$2"
    # shellcheck disable=SC2053
    [[ "$rel" == $pat ]] || return 1
    [[ "$pat" == *"**"* ]] && return 0
    local rel_slashes="${rel//[^\/]/}" pat_slashes="${pat//[^\/]/}"
    [[ ${#rel_slashes} -eq ${#pat_slashes} ]]
}

# Workspace package dirs of this project relative to $TARGET_PATH (one per
# line, root excluded): dirs holding a package.json that match a workspace
# glob and no "!" exclusion. node_modules and .git are never descended.
# Sorted (C locale) because find's order is filesystem-dependent (ext4 on CI
# returns hash order) and missing_node_modules must be reproducible.
workspace_pkg_dirs() {
    local pm="$1"
    local patterns
    patterns=$(workspace_patterns "$pm")
    [[ -n "$patterns" ]] || return 0
    local candidates
    candidates=$(cd "$TARGET_PATH" && find . \( -name node_modules -o -name .git \) -prune -o -type f -name package.json -print 2>/dev/null \
        | sed -e 's#^\./##' -e 's#/\{0,1\}package\.json$##' | LC_ALL=C sort) || return 0
    local rel pat included
    while IFS= read -r rel; do
        [[ -n "$rel" ]] || continue
        included=false
        while IFS= read -r pat; do
            [[ -n "$pat" ]] || continue
            if [[ "$pat" == '!'* ]]; then
                workspace_glob_match "$rel" "${pat#!}" && { included=false; break; }
            elif workspace_glob_match "$rel" "$pat"; then
                included=true
            fi
        done <<< "$patterns"
        [[ "$included" == true ]] && printf '%s\n' "$rel"
    done <<< "$candidates"
    return 0
}
