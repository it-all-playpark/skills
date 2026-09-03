#!/usr/bin/env bash
# veridelta-archive.sh - worktree teardown 前に .veridelta/runs/*.json を
# 中央 archive-root へ退避し、保持上限(件数/バイト)を超えた古い entry を回収する。
#
# 実行文脈: 非 sandbox の human terminal での実行を前提とする。Claude sandbox 下では
# repo 内書き込みが deny され常時 fail-open no-op になる（sandbox 経由で使う場合は
# .claude/settings.json の sandbox write allow へ .veridelta-archive/ の追加が必要）。
#
# 使い方: veridelta-archive.sh <worktree-path> [archive-root]
#   archive-root 省略時は `git -C <worktree> rev-parse --path-format=absolute
#   --git-common-dir` の親ディレクトリ + /.veridelta-archive に解決する。
#
# 出力(stdout, JSON 1行):
#   no-op(.veridelta/runs/*.json が0件): {"ok":true,"archived":0,"dest":"","pruned":0}
#   成功: {"ok":true,"archived":N,"dest":"<entry-dir>","pruned":M}
#   失敗(fail-open): {"ok":false,"reason":"..."}
#
# Exit: 常に 0（fail-open。呼び出し側の teardown を fail させないため）。
#       引数不足のみ usage を stderr に出し exit 2。
set -uo pipefail

# ============================================================================
# Args
# ============================================================================

if [ $# -lt 1 ]; then
    echo "Usage: veridelta-archive.sh <worktree-path> [archive-root]" >&2
    exit 2
fi

WT="$1"
ARCHIVE_ROOT="${2:-}"

MAX_ENTRIES="${VDELTA_ARCHIVE_MAX_ENTRIES:-50}"
MAX_BYTES="${VDELTA_ARCHIVE_MAX_BYTES:-52428800}"
LOG_FILE="${VDELTA_ARCHIVE_LOG:-$HOME/.claude/logs/veridelta-archive.log}"

# ============================================================================
# Helpers
# ============================================================================

json_escape() {
    # 簡易 JSON 文字列エスケープ(バックスラッシュ・ダブルクォートのみ。囲みなし)
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

log_trace() {
    # fail-open 時の痕跡ログ。log 先の mkdir -p も失敗したら stderr のみに留める。
    local reason="$1"
    local log_dir
    log_dir="$(dirname "$LOG_FILE")"
    if mkdir -p "$log_dir" 2>/dev/null; then
        printf '%s [veridelta-archive] worktree=%s reason=%s\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WT" "$reason" >> "$LOG_FILE" 2>/dev/null
    fi
    echo "veridelta-archive: $reason" >&2
}

fail_open() {
    # fail-open: 常に exit 0 で呼び出し側を落とさない
    local reason="$1"
    log_trace "$reason"
    printf '{"ok":false,"reason":"%s"}\n' "$(json_escape "$reason")"
    exit 0
}

# ============================================================================
# archive-root 解決
# ============================================================================

if [ -z "$ARCHIVE_ROOT" ]; then
    common_dir="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
    if [ -z "$common_dir" ]; then
        fail_open "failed to resolve git-common-dir for default archive-root"
    fi
    repo_root="$(dirname "$common_dir")"
    ARCHIVE_ROOT="$repo_root/.veridelta-archive"
fi

# ============================================================================
# .veridelta/runs/*.json の収集(0件なら no-op)
# ============================================================================

RUNS_DIR="$WT/.veridelta/runs"
json_files=()
if [ -d "$RUNS_DIR" ]; then
    json_list="$(find "$RUNS_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | sort)"
    if [ -n "$json_list" ]; then
        while IFS= read -r f; do
            json_files+=("$f")
        done <<< "$json_list"
    fi
fi

if [ "${#json_files[@]}" -eq 0 ]; then
    printf '{"ok":true,"archived":0,"dest":"","pruned":0}\n'
    exit 0
fi

# ============================================================================
# entry ディレクトリを決定(同名衝突は -2, -3... で回避)
# ============================================================================

ts="$(date -u +%Y%m%dT%H%M%SZ)"
wt_base="$(basename "$WT")"
entry_name="${ts}-${wt_base}"
entry_dir="$ARCHIVE_ROOT/$entry_name"
suffix=2
while [ -e "$entry_dir" ]; do
    entry_dir="$ARCHIVE_ROOT/${entry_name}-${suffix}"
    suffix=$((suffix + 1))
done

if ! mkdir -p "$entry_dir" 2>/dev/null; then
    fail_open "mkdir failed for entry dir: $entry_dir"
fi

archived=0
for f in "${json_files[@]}"; do
    if ! cp "$f" "$entry_dir/" 2>/dev/null; then
        fail_open "cp failed for $f"
    fi
    archived=$((archived + 1))
done

# ============================================================================
# Retention: 件数上限 -> バイト上限(残り1件で打ち切り)の順に最古 entry を回収
# ============================================================================

list_entries() {
    find "$ARCHIVE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort
}

total_bytes() {
    local total=0 sz f files
    files="$(find "$ARCHIVE_ROOT" -type f 2>/dev/null)"
    if [ -n "$files" ]; then
        while IFS= read -r f; do
            sz="$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)"
            total=$((total + sz))
        done <<< "$files"
    fi
    printf '%d' "$total"
}

refresh_entries() {
    entries=()
    local list
    list="$(list_entries)"
    if [ -n "$list" ]; then
        while IFS= read -r e; do
            entries+=("$e")
        done <<< "$list"
    fi
}

pruned=0

entries=()
refresh_entries

while [ "${#entries[@]}" -gt "$MAX_ENTRIES" ]; do
    oldest="${entries[0]}"
    rm -rf "$oldest"
    pruned=$((pruned + 1))
    refresh_entries
done

while [ "${#entries[@]}" -gt 1 ]; do
    tb="$(total_bytes)"
    if [ "$tb" -le "$MAX_BYTES" ]; then
        break
    fi
    oldest="${entries[0]}"
    rm -rf "$oldest"
    pruned=$((pruned + 1))
    refresh_entries
done

# ============================================================================
# Output JSON
# ============================================================================

printf '{"ok":true,"archived":%d,"dest":"%s","pruned":%d}\n' \
    "$archived" "$(json_escape "$entry_dir")" "$pruned"
exit 0
