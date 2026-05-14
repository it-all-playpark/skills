#!/usr/bin/env bash
# AC5 雛形: skill-retrospective journal から直近 7 日間の glue 由来エラー件数を report
# NOTE: しきい値判定は本 PR では skip (baseline 未確立)。件数 report のみ、常に exit 0。
# 後続 issue #82 で baseline 比較 ON にする。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Journal 探索 path (project-level skill repo or user-level)
JOURNAL_CANDIDATES=(
    "$REPO_ROOT/skill-retrospective/journal"
    "$HOME/.claude/skills/skill-retrospective/journal"
    "$HOME/.claude/journal"
)

JOURNAL_DIR=""
for d in "${JOURNAL_CANDIDATES[@]}"; do
    if [[ -d "$d" ]]; then JOURNAL_DIR="$d"; break; fi
done

# Glue-related error patterns (escape for grep -E)
PATTERNS=(
    "worktree.*not found"
    "--worktree.*not"
    "\.env.*not.*copied"
    "worktree-agent-[a-f0-9]+"
    "phase_failed.*worktree"
)

COUNT=0
SAMPLES=()

if [[ -n "$JOURNAL_DIR" ]]; then
    # Only files modified in last 7 days
    while IFS= read -r -d '' log; do
        for pat in "${PATTERNS[@]}"; do
            MATCHES=$(grep -ciE "$pat" "$log" 2>/dev/null); MATCHES=${MATCHES:-0}
            COUNT=$((COUNT + MATCHES))
            if [[ "$MATCHES" -gt 0 && ${#SAMPLES[@]} -lt 3 ]]; then
                SAMPLES+=("$(basename "$log"): $pat × $MATCHES")
            fi
        done
    done < <(find "$JOURNAL_DIR" -name "*.json" -mtime -7 -print0 2>/dev/null || true)
fi

echo "=== Glue-related error scan (AC5 雛形) ==="
echo "Journal dir: ${JOURNAL_DIR:-(not found)}"
echo "Window: last 7 days"
echo "Patterns: ${#PATTERNS[@]} patterns"
echo "Total occurrences: $COUNT"
if [[ ${#SAMPLES[@]} -gt 0 ]]; then
    echo "Samples (first 3):"
    for s in "${SAMPLES[@]}"; do echo "  - $s"; done
fi
echo "NOTE: しきい値判定は本 PR では skip。報告のみ、exit 0 で常に PASS。"
echo "      baseline 比較 ON は後続 issue #82 で実施。"
echo "OK: tests/no-glue-errors.sh (report only)"

exit 0
