#!/usr/bin/env bash
#
# extract-behavioral-claims.sh
#
# MDX 記事から「動作・因果関係（behavioral / causal）の妥当性」主張を抽出する。
# 検出は「文単位の正規表現マッチ (BC1〜BC5)」+「同一文に fabrication-signal トークンが
# 1 個以上存在」の AND 条件。signal が無い文 (表面パターンだけマッチした文) は drop。
#
# 出力: JSON {"claims": [{line, text, pattern_id, signal_tokens, extra_patterns,
#                          surrounding_context}], "file": "<abs path>"}
#
# Usage:
#   extract-behavioral-claims.sh <mdx-file>
#
# Exit:
#   0 - 成功 (claims が 0 件でも成功扱い)
#   1 - 入力エラー
#
# 依存: jq, awk, grep -E, sed (Bash の curl/wget は permissions.deny でブロックされるため使わない)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck disable=SC1091
source "$SKILLS_DIR/_lib/common.sh"

require_cmd jq
require_cmd awk
require_cmd grep
require_cmd sed

INPUT_FILE="${1:-}"
if [[ -z "$INPUT_FILE" ]]; then
  die_json "Usage: extract-behavioral-claims.sh <mdx-file>" 1
fi
if [[ ! -f "$INPUT_FILE" ]]; then
  die_json "File not found: $INPUT_FILE" 1
fi

ABS_FILE="$(cd "$(dirname "$INPUT_FILE")" && pwd)/$(basename "$INPUT_FILE")"

# ============================================================================
# Signal-token regex (詳細は references/behavioral-claims.md 参照)
# ============================================================================
# allowlist 化した HTTP status code (年号などとの誤マッチを避けるため固定値のみ)
readonly SIGNAL_REGEX='(\<(200|201|204|301|302|304|400|401|403|404|405|410|422|429|500|502|503|504)\>|\<(SIGKILL|SIGTERM|SIGHUP|SIGINT|SIGQUIT|SIGPIPE|SIGABRT|SIGSEGV|SIGUSR1|SIGUSR2|EADDRINUSE|EACCES|ENOENT|ETIMEDOUT|EPIPE|EXIT)\>|`[A-Za-z][A-Za-z0-9_./-]*[-_./][A-Za-z0-9_./-]*`|\<(NODE_ENV|HTTP_PROXY|PATH|HOME|PWD|XDG_[A-Z_]+|CLAUDE_[A-Z_]+|GITHUB_[A-Z_]+|AWS_[A-Z_]+|DB_[A-Z_]+)\>|\<(TCP|UDP|TLS|SSL|DNS|gRPC|WebSocket|RST|FIN|SYN|ACK)\>|HTTP/?[12](\.[01])?|port[[:space:]]+[0-9]+|[A-Z][A-Za-z]+[[:space:]]+v?[0-9]+\.[0-9]+(\.[0-9]+)?|\<(PreToolUse|PostToolUse|SessionStart|SessionEnd|UserPromptSubmit|Stop|SubagentStop|Notification)\>|\<[0-9]+(\.[0-9]+)?[[:space:]]?(ms|sec|秒|分|MB|GB|KB|%)\>)'

# ============================================================================
# Hedge / question / quotation 除外用 (signal pass 後の最終フィルタ)
# ============================================================================
readonly HEDGE_REGEX='(かもしれな|かもしれません|得る|うる|と思われ|ではないか|でしょうか|ますか[？?]|ですか[？?]|の?場合があ|することがあ|することができ|することがで?きる|することもあ|することもありま)'

# ============================================================================
# Pattern definitions (BC1〜BC5)
# 各 pattern は ERE (POSIX extended)、grep -E と互換。
# 緩い変種を許容し、後段の signal 検査で AND を取って precision を確保する。
# ============================================================================

# BC1: 結果型「〜を実行/呼び出し すると〜になる/返る/起きる」 + 緩い変種「すると|したら ... なる/返る/出る/起きる」
# 注: macOS BSD grep の `[^[:space:]]+` は multi-byte (日本語) 文字とのマッチに不安定なため、
#     prefix を省略し signal 共起 AND 検査で precision を確保する。
#     trigger は (1) "を実行/呼び出/.../を発行" + "すると|したら"、または
#     (2) 凝縮形 "を実行すると / を呼び出すと / を発行すると / を呼ぶと" 等の "(動詞語幹)+ると"、
#     さらに保険として (3) "(すると|したら)" 単独 + result phrase。
readonly BC1_REGEX='((を実行する?と|を呼び出す?と|を叩くと|を投げると|を打つと|に渡すと|を発行すると|を呼ぶと).*(になる|になります|が返る|が返ります|を返す|を返します|が出る|が出ます|が起きる|が起きます|が返って|が返って?きます|が出て|が起こり|が走る|が走ります|が呼ばれる|が呼ばれます))|((を実行|を呼び出|を叩|を投げ|を打|に渡|を発行).*(すると|したら).*(になる|になります|が返る|が返ります|を返す|を返します|が出る|が出ます|が起きる|が起きます|が返って|が返って?きます|が出て|が起こり))|((すると|したら).*(が返って|が返り|が返る|を返す|を返し|が出る|が出ます|が起き|になり))'

# BC2: 実行→内部動作「〜を実行/呼び出/発火 すると〜が走る/呼ばれる/起動する/発火する」
readonly BC2_REGEX='(を実行|を呼び出|を発火|を trigger).*(が走る|が走ります|が呼ばれる|が呼ばれます|が起動する|が起動します|が発火する|が発火します)'

# BC3: 内部実装「〜は/では (内部で|裏側で|内部的に) 〜を返す/受け取る/実行する」
readonly BC3_REGEX='(は|では).*(内部で|裏側で|内部的に).*(を返す|を返します|を受け取る|を受け取ります|を実行する|を実行します|を発行する|を発行します|を投げる|を投げます|を返して|を返し)'

# BC4: 原因型「〜が原因で〜が起きる」「〜により〜される」
# 「により」は signal 検査で AND を取る。先頭・直後の文字制限は省略（multi-byte 不安定対策）。
readonly BC4_REGEX='(が原因で.*(が起きる|が起きます|が発生する|が発生します|が起き|が発生し))|((により|によって).*((が|を).*(発生|起動|終了|kill|abort)(される|されます)?|される|されます|を返す|を返します|abort される|kill される))'

# BC5: 場所＋呼出「〜では〜が呼ばれる/走る/フックされる」
readonly BC5_REGEX='(では).*(が呼ばれる|が呼ばれます|が走る|が走ります|がフック(される|されます))'

# ============================================================================
# Helper functions
# ============================================================================

# Build sentence list from MDX body.
# Output: lines of "<original-line-number>\t<sentence>"
# Excludes:
#   - YAML frontmatter (--- ... ---)
#   - fenced code blocks (``` ... ```)
#   - blockquote lines (^>)
# Sentences split by 。 or blank line.
# Skip empty sentences.
extract_sentences() {
  local file="$1"
  awk '
    BEGIN {
      in_frontmatter = 0
      frontmatter_done = 0
      in_fence = 0
      buf = ""
      buf_line = 0
    }
    {
      ln = NR
      line = $0

      # Frontmatter handling
      if (!frontmatter_done) {
        if (ln == 1 && line == "---") { in_frontmatter = 1; next }
        if (in_frontmatter && line == "---") {
          in_frontmatter = 0
          frontmatter_done = 1
          next
        }
        if (in_frontmatter) next
        frontmatter_done = 1
      }

      # Fence handling (``` or ~~~)
      if (match(line, /^[[:space:]]*(```|~~~)/)) {
        in_fence = 1 - in_fence
        # close pending sentence if any
        if (buf != "") { printf "%d\t%s\n", buf_line, buf; buf = ""; buf_line = 0 }
        next
      }
      if (in_fence) next

      # Blockquote
      if (match(line, /^[[:space:]]*>/)) {
        if (buf != "") { printf "%d\t%s\n", buf_line, buf; buf = ""; buf_line = 0 }
        next
      }

      # Blank line → flush
      if (line ~ /^[[:space:]]*$/) {
        if (buf != "") { printf "%d\t%s\n", buf_line, buf; buf = ""; buf_line = 0 }
        next
      }

      # Append to buffer (track first-line number)
      if (buf == "") buf_line = ln

      # Split current line by 。
      # Use split with empty placeholder
      n = split(line, parts, "。")
      for (i = 1; i <= n; i++) {
        seg = parts[i]
        # gsub leading whitespace
        sub(/^[[:space:]]+/, "", seg)
        if (i < n) {
          # closed sentence (had 。)
          combined = buf seg
          if (combined ~ /[^[:space:]]/) {
            printf "%d\t%s\n", buf_line, combined "。"
          }
          buf = ""
          buf_line = ln
        } else {
          # last segment (no terminator on this line)
          if (seg != "") {
            if (buf == "") buf_line = ln
            buf = buf seg
          }
        }
      }
    }
    END {
      if (buf != "") { printf "%d\t%s\n", buf_line, buf }
    }
  ' "$file"
}

# Collect signal tokens from a sentence (one per line, possibly empty)
collect_signals() {
  local sentence="$1"
  printf '%s' "$sentence" | grep -oE "$SIGNAL_REGEX" 2>/dev/null || true
}

# Test if a sentence matches a single BC regex.
matches_pattern() {
  local sentence="$1" regex="$2"
  printf '%s' "$sentence" | grep -qE "$regex"
}

# Test if a sentence is a hedge / question (drop it).
is_hedge() {
  local sentence="$1"
  printf '%s' "$sentence" | grep -qE "$HEDGE_REGEX"
}

# ============================================================================
# Main extraction
# ============================================================================
SENTENCES="$(extract_sentences "$ABS_FILE")"

# Build claims JSON array via jq (stream-safe).
# Use a temp NDJSON, then aggregate.
TMP_NDJSON="$(mktemp -t bcclaims-XXXXXX.ndjson)"
trap 'rm -f "$TMP_NDJSON"' EXIT

while IFS=$'\t' read -r line text; do
  [[ -z "${text:-}" ]] && continue

  # Skip hedges / questions early
  if is_hedge "$text"; then
    continue
  fi

  matched=""
  extras=()

  if matches_pattern "$text" "$BC1_REGEX"; then matched="${matched:-BC1}"; [[ "$matched" != "BC1" ]] && extras+=("BC1"); fi
  if matches_pattern "$text" "$BC2_REGEX"; then
    if [[ -z "$matched" ]]; then matched="BC2"; else extras+=("BC2"); fi
  fi
  if matches_pattern "$text" "$BC3_REGEX"; then
    if [[ -z "$matched" ]]; then matched="BC3"; else extras+=("BC3"); fi
  fi
  if matches_pattern "$text" "$BC4_REGEX"; then
    if [[ -z "$matched" ]]; then matched="BC4"; else extras+=("BC4"); fi
  fi
  if matches_pattern "$text" "$BC5_REGEX"; then
    if [[ -z "$matched" ]]; then matched="BC5"; else extras+=("BC5"); fi
  fi

  [[ -z "$matched" ]] && continue

  # Signal co-occurrence check
  signals="$(collect_signals "$text" | awk 'NF' | sort -u)"
  if [[ -z "$signals" ]]; then
    continue
  fi

  # Build JSON record
  signal_array="$(printf '%s\n' "$signals" | jq -R . | jq -cs '.')"

  if (( ${#extras[@]} > 0 )); then
    extras_array="$(printf '%s\n' "${extras[@]}" | jq -R . | jq -cs '. | unique')"
  else
    extras_array='[]'
  fi

  jq -cn \
    --argjson line "$line" \
    --arg text "$text" \
    --arg pid "$matched" \
    --argjson signals "$signal_array" \
    --argjson extras "$extras_array" \
    '{line: $line, text: $text, pattern_id: $pid, signal_tokens: $signals, extra_patterns: $extras, surrounding_context: ""}' \
    >> "$TMP_NDJSON"

done <<< "$SENTENCES"

# Aggregate to final JSON.
if [[ -s "$TMP_NDJSON" ]]; then
  CLAIMS="$(jq -cs '.' "$TMP_NDJSON")"
else
  CLAIMS='[]'
fi

jq -cn \
  --arg file "$ABS_FILE" \
  --argjson claims "$CLAIMS" \
  '{file: $file, claims: $claims}'
