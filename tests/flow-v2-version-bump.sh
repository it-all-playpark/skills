#!/usr/bin/env bash
# tests/flow-v2-version-bump.sh
#
# Invariant test (issue #108 Phase 1): detects stale "2.0.0" literals in
# flow.json schema / scripts / tests / dev-decompose seed after v2.0.0 → v2.1.0 bump.
#
# Allowlist: doc / changelog / comment lines are skipped. Only literal "2.0.0"
# inside the active code paths is treated as a leftover.
#
# Targets:
#   _lib/schemas/flow.schema.json
#   _lib/scripts/flow-read.sh
#   _lib/scripts/flow-update.sh
#   _lib/scripts/validate-decomposition.sh
#   dev-flow/scripts/flow-status.sh
#   dev-decompose/scripts/init-flow-v2.sh
#   tests/flow-schema-v2-validate.sh
#   tests/validate-decomposition-v2-branch.sh
#
# Exit 0 = clean. Exit 1 = leftover found.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGETS=(
    "_lib/schemas/flow.schema.json"
    "_lib/scripts/flow-read.sh"
    "_lib/scripts/flow-update.sh"
    "_lib/scripts/validate-decomposition.sh"
    "dev-flow/scripts/flow-status.sh"
    "dev-decompose/scripts/init-flow-v2.sh"
    "dev-integrate/scripts/verify-children-merged.sh"
    "tests/flow-schema-v2-validate.sh"
    "tests/validate-decomposition-v2-branch.sh"
)

LEFTOVERS=()

for rel in "${TARGETS[@]}"; do
    path="$REPO_ROOT/$rel"
    if [[ ! -f "$path" ]]; then
        echo "WARN: target file missing: $rel" >&2
        continue
    fi
    # Grep with line number, then exclude commented lines starting with #, *, //, --
    # AND markdown headings/code fences. We require the bare literal "2.0.0" (with double quotes).
    matches=$(grep -nE '"2\.0\.0"' "$path" | grep -vE '^[[:space:]]*[0-9]+:[[:space:]]*(#|\*|//|--|;)' || true)
    if [[ -n "$matches" ]]; then
        LEFTOVERS+=("=== $rel ===")
        while IFS= read -r line; do
            LEFTOVERS+=("$line")
        done <<< "$matches"
    fi
done

if (( ${#LEFTOVERS[@]} > 0 )); then
    echo "FAIL: stale \"2.0.0\" literal(s) detected in code paths after v2.1 bump:" >&2
    printf '%s\n' "${LEFTOVERS[@]}" >&2
    exit 1
fi

echo "OK: no stale \"2.0.0\" literals in active flow.json code paths."
