#!/usr/bin/env bash
# test-extract-behavioral-claims.sh - Unit tests for extract-behavioral-claims.sh
# Run: ./blog-fact-check/tests/test-extract-behavioral-claims.sh
#
# テストフレーム: dev-flow-doctor/tests/test-analyze-dev-flow-family.sh のスタイル
#   - pass / fail / assert_eq / assert_contains 関数
#   - PASS/FAIL カウントを末尾に印字
#   - FAIL_COUNT > 0 で exit 1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACT_SH="$SCRIPT_DIR/../scripts/extract-behavioral-claims.sh"
SKILL_MD="$SCRIPT_DIR/../SKILL.md"
REFERENCE_MD="$SCRIPT_DIR/../references/behavioral-claims.md"
POSITIVE_DIR="$SCRIPT_DIR/fixtures/behavioral-claims/positive"
NEGATIVE_DIR="$SCRIPT_DIR/fixtures/behavioral-claims/negative"
WORKDIR="$(mktemp -d -t bfc-bc-test-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

FAIL_COUNT=0
PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  if [[ -n "${2:-}" ]]; then
    printf '        %s\n' "$2"
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label" "expected='$expected' actual='$actual'"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label" "haystack does not contain '$needle' (haystack first 200 chars: ${haystack:0:200})"
  fi
}

assert_ge() {
  local label="$1" lhs="$2" rhs="$3"
  if (( lhs >= rhs )); then
    pass "$label"
  else
    fail "$label" "expected ($lhs) >= ($rhs)"
  fi
}

# ----------------------------------------------------------------------------
# Helper: run extract on a fixture file and return JSON
# ----------------------------------------------------------------------------
run_extract() {
  local file="$1"
  "$EXTRACT_SH" "$file" 2>&1
}

claims_count() {
  local json="$1"
  echo "$json" | jq '.claims | length' 2>/dev/null || echo "ERR"
}

printf 'Test suite: extract-behavioral-claims.sh\n'
printf 'Script: %s\n' "$EXTRACT_SH"
printf 'Positive fixtures: %s\n' "$POSITIVE_DIR"
printf 'Negative fixtures: %s\n\n' "$NEGATIVE_DIR"

# ============================================================================
# AC1: SKILL.md doc-grep tests
# ============================================================================
printf 'AC1: SKILL.md updates\n'

SKILL_CONTENT="$(cat "$SKILL_MD" 2>/dev/null || true)"

# AC1.1: check_targets default 表に behavioral_claims が含まれる
if [[ "$SKILL_CONTENT" == *'check_targets'* ]] && \
   echo "$SKILL_CONTENT" | grep -E 'check_targets[^|]*\|[^|]*behavioral_claims' > /dev/null; then
  pass "AC1.1: check_targets default に behavioral_claims が含まれる"
else
  fail "AC1.1: check_targets default に behavioral_claims が含まれる" \
    "Default 表 (check_targets 行) に behavioral_claims が見つからない"
fi

# AC1.2: review_only_categories default 表に behavioral_claims が含まれる
if echo "$SKILL_CONTENT" | grep -E 'review_only_categories[^|]*\|[^|]*behavioral_claims' > /dev/null; then
  pass "AC1.2: review_only_categories default に behavioral_claims が含まれる"
else
  fail "AC1.2: review_only_categories default に behavioral_claims が含まれる" \
    "Default 表 (review_only_categories 行) に behavioral_claims が見つからない"
fi

# AC1.3: frontmatter description の --category 引数列挙に behavioral_claims が含まれる
# frontmatter から最初の category 列挙を取得
DESCRIPTION_BLOCK="$(awk '/^---$/{c++; next} c==1 && /description:/{flag=1} c==1 && flag {print; if (/Accepts args/) exit}' "$SKILL_MD" 2>/dev/null || true)"
if echo "$DESCRIPTION_BLOCK" | grep -E -- '--category[^|]*\|[^|]*behavioral_claims' > /dev/null \
   || echo "$DESCRIPTION_BLOCK" | grep -F 'behavioral_claims' > /dev/null; then
  pass "AC1.3: frontmatter description の --category に behavioral_claims が含まれる"
else
  fail "AC1.3: frontmatter description の --category に behavioral_claims が含まれる" \
    "description block: $DESCRIPTION_BLOCK"
fi

# ============================================================================
# AC4: reference file doc-grep tests (位置: AC2 より先に reference 存在を担保)
# ============================================================================
printf '\nAC4: references/behavioral-claims.md\n'

if [[ ! -f "$REFERENCE_MD" ]]; then
  fail "AC4: reference file 存在" "$REFERENCE_MD が存在しない"
else
  pass "AC4: reference file 存在"

  REFERENCE_CONTENT="$(cat "$REFERENCE_MD")"
  required_sections=("パターン" "Fabrication-signal" "verify" "ヘッジ" "除外")
  missing=""
  for section in "${required_sections[@]}"; do
    if ! echo "$REFERENCE_CONTENT" | grep -i -F "$section" > /dev/null; then
      missing="$missing $section"
    fi
  done
  if [[ -z "$missing" ]]; then
    pass "AC4: reference 5 セクション (パターン / Fabrication-signal / verify / ヘッジ / 除外) 全て存在"
  else
    fail "AC4: reference 5 セクション全て存在" "missing:$missing"
  fi
fi

# ============================================================================
# Script existence pre-check
# ============================================================================
if [[ ! -x "$EXTRACT_SH" ]]; then
  printf '\n\033[31mFATAL\033[0m: %s が存在しないか実行可能でない。\n' "$EXTRACT_SH"
  printf 'Total: %d passed, %d failed (script missing)\n' "$PASS_COUNT" "$((FAIL_COUNT + 1))"
  exit 1
fi

# ============================================================================
# AC2: BC1〜BC5 + multi-pattern 検出
# ============================================================================
printf '\nAC2: BC pattern detection\n'

# AC2.1: BC1 fixture (curl-permission-deny.mdx) → 1 件以上検出
JSON_BC1="$(run_extract "$POSITIVE_DIR/curl-permission-deny.mdx")"
N_BC1="$(claims_count "$JSON_BC1")"
assert_ge "AC2.1: BC1 (curl + 403) で 1 件以上検出" "${N_BC1:-0}" "1"

# AC2.2: BC2 fixture (hook-lifecycle.mdx 内 PreToolUse 実行→呼ばれる) → 1 件以上検出
JSON_HOOK="$(run_extract "$POSITIVE_DIR/hook-lifecycle.mdx")"
N_HOOK="$(claims_count "$JSON_HOOK")"
assert_ge "AC2.2: BC2 (hook-lifecycle) で 1 件以上検出" "${N_HOOK:-0}" "1"

# AC2.3: BC3 fixture (api-rate-limit.mdx 内「内部で」 + 429) → 1 件以上検出
JSON_API="$(run_extract "$POSITIVE_DIR/api-rate-limit.mdx")"
N_API="$(claims_count "$JSON_API")"
assert_ge "AC2.3: BC3 (api-rate-limit, 内部で + 429) で 1 件以上検出" "${N_API:-0}" "1"

# AC2.4: BC4 fixture (db-lock-mechanism.mdx 内「により〜される」 + MySQL 8.0 等) → 1 件以上検出
JSON_DB="$(run_extract "$POSITIVE_DIR/db-lock-mechanism.mdx")"
N_DB="$(claims_count "$JSON_DB")"
assert_ge "AC2.4: BC4 (db-lock-mechanism) で 1 件以上検出" "${N_DB:-0}" "1"

# AC2.5: BC5 fixture (hook-lifecycle.mdx 内 PostToolUse では 〜呼ばれる) → 既に hook で含まれているが pattern_id BC5 が出現するか確認
# hook-lifecycle.mdx 内 BC5 ヒット文に pattern_id BC5 または extra_patterns BC5 が含まれること
HAS_BC5="$(echo "$JSON_HOOK" | jq -r '
  [.claims[]
   | (.pattern_id == "BC5") or (.extra_patterns | type == "array" and (any(. == "BC5"))) ]
  | any
' 2>/dev/null || echo "false")"
assert_eq "AC2.5: BC5 (hook-lifecycle 内 〜では〜が呼ばれる) が検出される" "true" "$HAS_BC5"

# AC2.6: multi-pattern (dns-tcp-behavior.mdx) → 3 件以上検出
JSON_DNS="$(run_extract "$POSITIVE_DIR/dns-tcp-behavior.mdx")"
N_DNS="$(claims_count "$JSON_DNS")"
assert_ge "AC2.6: multi-pattern (dns-tcp) で 3 件以上検出" "${N_DNS:-0}" "3"

# ============================================================================
# AC3: JSON schema
# ============================================================================
printf '\nAC3: JSON schema\n'

# AC3.1: claims[] に必須フィールドが存在する
FIRST_CLAIM="$(echo "$JSON_BC1" | jq '.claims[0]' 2>/dev/null || echo "null")"
HAS_LINE="$(echo "$FIRST_CLAIM" | jq 'has("line")' 2>/dev/null || echo "false")"
HAS_TEXT="$(echo "$FIRST_CLAIM" | jq 'has("text")' 2>/dev/null || echo "false")"
HAS_PATTERN_ID="$(echo "$FIRST_CLAIM" | jq 'has("pattern_id")' 2>/dev/null || echo "false")"
HAS_SIGNAL_TOKENS="$(echo "$FIRST_CLAIM" | jq 'has("signal_tokens")' 2>/dev/null || echo "false")"
HAS_EXTRA_PATTERNS="$(echo "$FIRST_CLAIM" | jq 'has("extra_patterns")' 2>/dev/null || echo "false")"

assert_eq "AC3.1a: claims[].line 存在" "true" "$HAS_LINE"
assert_eq "AC3.1b: claims[].text 存在" "true" "$HAS_TEXT"
assert_eq "AC3.1c: claims[].pattern_id 存在" "true" "$HAS_PATTERN_ID"
assert_eq "AC3.1d: claims[].signal_tokens 存在" "true" "$HAS_SIGNAL_TOKENS"
assert_eq "AC3.1e: claims[].extra_patterns 存在" "true" "$HAS_EXTRA_PATTERNS"

# AC3.2: claims が配列
CLAIMS_TYPE="$(echo "$JSON_BC1" | jq -r '.claims | type' 2>/dev/null || echo "ERR")"
assert_eq "AC3.2: .claims が array 型" "array" "$CLAIMS_TYPE"

# ============================================================================
# AC5: negative fixtures で claims = 0
# ============================================================================
printf '\nAC5: negative fixtures (false positive = 0)\n'

JSON_NEG1="$(run_extract "$NEGATIVE_DIR/cross-post-pipeline-design.mdx")"
N_NEG1="$(claims_count "$JSON_NEG1")"
assert_eq "AC5.1: cross-post-pipeline-design で claims=0" "0" "${N_NEG1:-0}"

JSON_NEG2="$(run_extract "$NEGATIVE_DIR/seo-pipeline-ga4-gsc-trends.mdx")"
N_NEG2="$(claims_count "$JSON_NEG2")"
assert_eq "AC5.2: seo-pipeline-ga4-gsc-trends で claims=0" "0" "${N_NEG2:-0}"

JSON_NEG3="$(run_extract "$NEGATIVE_DIR/claude-code-skills-design-patterns.mdx")"
N_NEG3="$(claims_count "$JSON_NEG3")"
assert_eq "AC5.3: claude-code-skills-design-patterns で claims=0" "0" "${N_NEG3:-0}"

# AC5.4: verified false-positive 文 (L122 / L124 相当) を単独 input で 0 件
L122_MDX="$WORKDIR/l122-only.mdx"
cat > "$L122_MDX" <<'EOF'
---
title: L122 single-line fixture
---

実行スキルは `--task-id` と `--flow-state` を受け取り、状態ファイルから自分のスコープだけを読み出します。
EOF

JSON_L122="$(run_extract "$L122_MDX")"
N_L122="$(claims_count "$JSON_L122")"
assert_eq "AC5.4a: L122 単独 (実行スキルは ... を受け取り...) で claims=0" "0" "${N_L122:-0}"

L124_MDX="$WORKDIR/l124-only.mdx"
cat > "$L124_MDX" <<'EOF'
---
title: L124 single-line fixture
---

この「単一ライター設計」により、競合状態を構造的に防ぎます。
EOF

JSON_L124="$(run_extract "$L124_MDX")"
N_L124="$(claims_count "$JSON_L124")"
assert_eq "AC5.4b: L124 単独 (単一ライター設計により...) で claims=0" "0" "${N_L124:-0}"

# ============================================================================
# Summary
# ============================================================================
printf '\n----------------------------------------\n'
printf 'Summary: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
