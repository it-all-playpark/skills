#!/usr/bin/env bash
# tests/git-prepare-removed.sh
# Invariant tests for issue #89 + #93:
#   - git-prepare skill deletion (issue #89)
#   - dev-contract-worker subagent removal (issue #93, child-split mode 統一に伴う撤廃)
# Run: bash tests/git-prepare-removed.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ERRORS=()

_pass() { echo "  PASS: $1"; ((PASS++)) || true; }
_fail() { echo "  FAIL: $1"; ERRORS+=("$1"); ((FAIL++)) || true; }

echo "=== git-prepare-removed invariant tests ==="
echo ""

# Case 1: git-prepare skill directory does not exist
echo "[Case 1] git-prepare/ directory must not exist"
if [[ ! -d "$REPO_ROOT/git-prepare" ]]; then
  _pass "git-prepare/ directory is absent"
else
  _fail "git-prepare/ directory still exists at $REPO_ROOT/git-prepare"
fi

# Case 2: No git-prepare references in tracked source files
# Exclude: tests/ (these guard files contain the literal string),
#          claudedocs/ (session history), docs/superpowers/ (historical specs),
#          .claude/ (ephemeral state files like iterate.json / kickoff.json)
echo "[Case 2] No git-prepare references in *.md / *.json (excluding tests/, claudedocs/, docs/superpowers/, .claude/, _shared/references/worktree-isolation.md)"
RESIDUAL=$(grep -rn "git-prepare" "$REPO_ROOT" \
  --include="*.md" \
  --include="*.json" \
  --exclude-dir=.git \
  --exclude-dir=.claude \
  --exclude-dir=tests \
  --exclude-dir=claudedocs \
  --exclude-dir=superpowers \
  2>/dev/null \
  | grep -v "_shared/references/worktree-isolation.md" \
  || true)
if [[ -z "$RESIDUAL" ]]; then
  _pass "No residual git-prepare references in .md/.json files"
else
  _fail "Residual git-prepare references found in .md/.json files:"
  echo "$RESIDUAL" | head -20 | sed 's/^/    /'
fi

# Case 2b: No git-prepare in *.sh files (excluding tests/ which hold guard patterns)
echo "[Case 2b] No git-prepare references in *.sh files (excluding tests/)"
RESIDUAL_SH=$(grep -rn "git-prepare" "$REPO_ROOT" \
  --include="*.sh" \
  --exclude-dir=.git \
  --exclude-dir=.claude \
  --exclude-dir=tests \
  --exclude-dir=claudedocs \
  2>/dev/null || true)
if [[ -z "$RESIDUAL_SH" ]]; then
  _pass "No residual git-prepare references in .sh files"
else
  _fail "Residual git-prepare references found in .sh files:"
  echo "$RESIDUAL_SH" | head -20 | sed 's/^/    /'
fi

# Case 3: dev-contract-worker.md must NOT exist (issue #93 で撤廃)
echo "[Case 3] .claude/agents/dev-contract-worker.md must NOT exist (issue #93 撤廃)"
if [[ ! -f "$REPO_ROOT/.claude/agents/dev-contract-worker.md" ]]; then
  _pass "dev-contract-worker.md is absent"
else
  _fail "dev-contract-worker.md still exists at $REPO_ROOT/.claude/agents/dev-contract-worker.md"
fi

# Case 3b: dev-kickoff-worker.md exists and is single-mode only (issue #93)
#
# 旧実装は `grep -q ... | grep -v ...` という pipeline を使っていたが、`grep -q` は
# stdout に何も書き出さないため後段の grep -v が常に空入力に対して exit 1 を返し、
# `set -euo pipefail` 環境では if 文が常に else 分岐に入っていた（regression を
# 検出できなかった）。行ベースで OFFENDING を抽出して長さで判定する形式に統一する。
echo "[Case 3b] dev-kickoff-worker.md must declare single mode only"
KICKOFF_AGENT="$REPO_ROOT/.claude/agents/dev-kickoff-worker.md"
if [[ -f "$KICKOFF_AGENT" ]]; then
  OFFENDING=$(grep -nE "mode.*parallel|mode.*merge" "$KICKOFF_AGENT" 2>/dev/null \
                | grep -v -E "撤廃|removed|must be \`single\`|removed in issue #93|parallel/merge removed" \
                || true)
  if [[ -n "$OFFENDING" ]]; then
    _fail "dev-kickoff-worker.md still references parallel/merge mode without removal annotation:"
    echo "$OFFENDING" | head -5 | sed 's/^/    /'
  else
    _pass "dev-kickoff-worker.md is single-mode only"
  fi
else
  _fail "dev-kickoff-worker.md missing"
fi

# Case 4: _shared/references/worktree-isolation.md exists with required sections
echo "[Case 4] _shared/references/worktree-isolation.md must exist with spike result sections"
ISOLATION_FILE="$REPO_ROOT/_shared/references/worktree-isolation.md"
if [[ -f "$ISOLATION_FILE" ]]; then
  MISSING_SECTIONS=()
  grep -qE "worktreePath|worktree_path" "$ISOLATION_FILE" || MISSING_SECTIONS+=("worktreePath/worktree_path")
  grep -qE "\[locked\]|locked" "$ISOLATION_FILE" || MISSING_SECTIONS+=("[locked]/locked")
  grep -qE "git-common-dir|GIT_COMMON_DIR" "$ISOLATION_FILE" || MISSING_SECTIONS+=("git-common-dir/GIT_COMMON_DIR")
  if [[ ${#MISSING_SECTIONS[@]} -eq 0 ]]; then
    _pass "worktree-isolation.md exists with required spike result sections"
  else
    _fail "worktree-isolation.md missing sections: ${MISSING_SECTIONS[*]}"
  fi
else
  _fail "worktree-isolation.md missing at $ISOLATION_FILE"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ $FAIL -gt 0 ]]; then
  echo "Failed cases:"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
  exit 1
fi
exit 0
