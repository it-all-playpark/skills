# Night Patrol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自律巡回開発スキル — コードベースをスキャンし、issue発見→作成→実装→PR→nightlyブランチマージを繰り返す

**Architecture:** 1スキル (`night-patrol`) + サブコマンド (`scan`/`triage`/`execute`/`report`) 構成。Phase 1 はスクリプト群で検出、Phase 2 はスクリプト + LLM判断でトリアージ、Phase 3 は既存 `dev-flow` に委譲、Phase 4 はレポート生成 + Telegram通知。

**Tech Stack:** Bash scripts (`_lib/common.sh` 依存)、`gh` CLI、`jq`、既存スキル群 (`dev-flow`, `code-audit-team`, `skill-retrospective`)

**Design Spec:** `docs/superpowers/specs/2026-04-01-night-patrol-design.md`

---

## File Structure

```
night-patrol/
├── SKILL.md                          ← オーケストレーター (新規)
├── scripts/
│   ├── scan-lint.sh                  ← 静的解析スキャン (新規)
│   ├── scan-tests.sh                 ← テスト失敗検出 (新規)
│   ├── scan-issues.sh                ← 未アサインissue取得 (新規)
│   ├── check-duplicates.sh           ← 重複issue検出 (新規)
│   ├── analyze-dependencies.sh       ← issue間依存解析 (新規)
│   ├── guard-check.sh                ← 安全ガード判定 (新規)
│   └── generate-report.sh            ← レポート生成 (新規)
└── references/
    └── safety-guards.md              ← ガード条件詳細 (新規)
```

---

## Task 1: scan-issues.sh — 未アサインGitHub Issue取得

最もシンプルなスクリプトから始める。`gh` CLI でissueを取得し、設定に基づいてフィルタする。

**Files:**
- Create: `night-patrol/scripts/scan-issues.sh`

- [ ] **Step 1: スクリプトのボイラープレート作成**

```bash
#!/usr/bin/env bash
# scan-issues.sh - Fetch unassigned GitHub issues matching filters
# Usage: scan-issues.sh [--allowed-labels LIST] [--denylist-labels LIST] [--denylist-issues LIST]
# Output: JSON array of issues

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

ALLOWED_LABELS=""
DENYLIST_LABELS=""
DENYLIST_ISSUES=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --allowed-labels) ALLOWED_LABELS="$2"; shift 2 ;;
        --denylist-labels) DENYLIST_LABELS="$2"; shift 2 ;;
        --denylist-issues) DENYLIST_ISSUES="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

require_gh_auth
require_git_repo
```

- [ ] **Step 2: gh issue list でissue取得ロジック実装**

```bash
# Build gh issue list command
GH_ARGS=(issue list --state open --assignee "" --json "number,title,labels,createdAt,body" --limit 100)

if [[ -n "$ALLOWED_LABELS" ]]; then
    IFS=',' read -ra LABELS <<< "$ALLOWED_LABELS"
    for label in "${LABELS[@]}"; do
        GH_ARGS+=(--label "$label")
    done
fi

ISSUES_RAW=$(gh "${GH_ARGS[@]}" 2>/dev/null || echo "[]")

# Filter denylist labels
if [[ -n "$DENYLIST_LABELS" ]] && has_jq; then
    DENYLIST_LABELS_JSON=$(echo "$DENYLIST_LABELS" | jq -R 'split(",")')
    ISSUES_RAW=$(echo "$ISSUES_RAW" | jq --argjson deny "$DENYLIST_LABELS_JSON" '
        [.[] | select(
            [.labels[].name] as $issue_labels |
            ($deny | map(. as $d | $issue_labels | any(. == $d)) | any) | not
        )]
    ')
fi

# Filter denylist issue numbers
if [[ -n "$DENYLIST_ISSUES" ]] && has_jq; then
    DENYLIST_ISSUES_JSON=$(echo "$DENYLIST_ISSUES" | jq -R 'split(",") | map(tonumber)')
    ISSUES_RAW=$(echo "$ISSUES_RAW" | jq --argjson deny "$DENYLIST_ISSUES_JSON" '
        [.[] | select(.number as $n | $deny | any(. == $n) | not)]
    ')
fi

# Format output
if has_jq; then
    echo "$ISSUES_RAW" | jq '[.[] | {
        number: .number,
        title: .title,
        labels: [.labels[].name],
        created_at: .createdAt
    }]'
else
    echo "$ISSUES_RAW"
fi
```

- [ ] **Step 3: 実行権限付与・動作確認**

Run: `chmod +x night-patrol/scripts/scan-issues.sh`
Run: `$SKILLS_DIR/night-patrol/scripts/scan-issues.sh --denylist-labels "do-not-autofix"`
Expected: JSON array of unassigned issues (or `[]` if none)

- [ ] **Step 4: コミット**

```bash
git add night-patrol/scripts/scan-issues.sh
git commit -m "feat(night-patrol): scan-issues.sh - 未アサインissue取得スクリプト"
```

---

## Task 2: scan-tests.sh — テスト失敗検出

プロジェクト種別を自動検出し、テストを実行して失敗・スキップを検出する。

**Files:**
- Create: `night-patrol/scripts/scan-tests.sh`

- [ ] **Step 1: スクリプト作成 — プロジェクト検出 + テスト実行**

```bash
#!/usr/bin/env bash
# scan-tests.sh - Detect failing and skipped tests
# Usage: scan-tests.sh [--dir PATH]
# Output: JSON array of test findings

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TARGET_DIR="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir) TARGET_DIR="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

require_git_repo

RESULTS="[]"

# Detect project type and run tests
if [[ -f "$TARGET_DIR/package.json" ]]; then
    # Node.js project — detect test runner
    if has_jq && jq -e '.scripts.test' "$TARGET_DIR/package.json" >/dev/null 2>&1; then
        # Detect package manager
        if [[ -f "$TARGET_DIR/pnpm-lock.yaml" ]]; then
            PKG_MGR="pnpm"
        elif [[ -f "$TARGET_DIR/yarn.lock" ]]; then
            PKG_MGR="yarn"
        else
            PKG_MGR="npm"
        fi

        # Run tests, capture output (allow failure)
        TEST_OUTPUT=$($PKG_MGR test --passWithNoTests 2>&1 || true)

        # Parse vitest/jest output for failures
        RESULTS=$(echo "$TEST_OUTPUT" | grep -E "^[[:space:]]*(FAIL|×|✕)" | head -50 | while IFS= read -r line; do
            test_name=$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/^(FAIL|×|✕)[[:space:]]*//')
            echo "{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "$line")}"
        done | jq -s '.' 2>/dev/null || echo "[]")

        # Detect skipped tests via grep in source
        SKIPPED=$(grep -rn "\.skip\|\.todo\|xit(\|xdescribe(" "$TARGET_DIR/tests" "$TARGET_DIR/test" "$TARGET_DIR/__tests__" "$TARGET_DIR/src" 2>/dev/null | head -30 | while IFS=: read -r file line_num content; do
            echo "{\"type\":\"skipped\",\"file\":$(json_str "$file"),\"line\":$line_num,\"content\":$(json_str "$content")}"
        done | jq -s '.' 2>/dev/null || echo "[]")

        # Merge
        if has_jq; then
            RESULTS=$(jq -s 'add' <(echo "$RESULTS") <(echo "$SKIPPED"))
        fi
    fi
elif [[ -f "$TARGET_DIR/Cargo.toml" ]]; then
    TEST_OUTPUT=$(cd "$TARGET_DIR" && cargo test 2>&1 || true)
    RESULTS=$(echo "$TEST_OUTPUT" | grep -E "^test .+ FAILED" | while IFS= read -r line; do
        test_name=$(echo "$line" | sed 's/^test //' | sed 's/ \.\.\. FAILED$//')
        echo "{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "$line")}"
    done | jq -s '.' 2>/dev/null || echo "[]")
elif [[ -f "$TARGET_DIR/go.mod" ]]; then
    TEST_OUTPUT=$(cd "$TARGET_DIR" && go test ./... 2>&1 || true)
    RESULTS=$(echo "$TEST_OUTPUT" | grep -E "^--- FAIL:" | while IFS= read -r line; do
        test_name=$(echo "$line" | sed 's/^--- FAIL: //' | sed 's/ (.*//')
        echo "{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "$line")}"
    done | jq -s '.' 2>/dev/null || echo "[]")
elif [[ -f "$TARGET_DIR/pyproject.toml" ]] || [[ -f "$TARGET_DIR/requirements.txt" ]]; then
    TEST_OUTPUT=$(cd "$TARGET_DIR" && python -m pytest --tb=line 2>&1 || true)
    RESULTS=$(echo "$TEST_OUTPUT" | grep -E "^FAILED" | while IFS= read -r line; do
        echo "{\"type\":\"failing\",\"test\":$(json_str "$line"),\"error\":$(json_str "$line")}"
    done | jq -s '.' 2>/dev/null || echo "[]")
fi

echo "$RESULTS"
```

- [ ] **Step 2: 実行権限付与・動作確認**

Run: `chmod +x night-patrol/scripts/scan-tests.sh`
Run: `$SKILLS_DIR/night-patrol/scripts/scan-tests.sh`
Expected: JSON array of test findings (or `[]`)

- [ ] **Step 3: コミット**

```bash
git add night-patrol/scripts/scan-tests.sh
git commit -m "feat(night-patrol): scan-tests.sh - テスト失敗・スキップ検出スクリプト"
```

---

## Task 3: scan-lint.sh — 静的解析スキャン

lint/型エラー/TODO/脆弱性をまとめて検出。

**Files:**
- Create: `night-patrol/scripts/scan-lint.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# scan-lint.sh - Scan for lint errors, type errors, TODOs, and vulnerabilities
# Usage: scan-lint.sh [--dir PATH]
# Output: JSON array of lint findings

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TARGET_DIR="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir) TARGET_DIR="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

require_git_repo

ALL_FINDINGS="[]"

if [[ -f "$TARGET_DIR/package.json" ]]; then
    # TypeScript type check
    if [[ -f "$TARGET_DIR/tsconfig.json" ]]; then
        TSC_OUTPUT=$(cd "$TARGET_DIR" && npx tsc --noEmit 2>&1 || true)
        TYPE_ERRORS=$(echo "$TSC_OUTPUT" | grep -E "^.+\([0-9]+,[0-9]+\): error" | head -50 | while IFS= read -r line; do
            file=$(echo "$line" | sed 's/(.*//')
            line_num=$(echo "$line" | grep -oP '\((\d+),' | tr -dc '0-9')
            msg=$(echo "$line" | sed 's/^.*: error //')
            echo "{\"type\":\"type_error\",\"file\":$(json_str "$file"),\"line\":${line_num:-0},\"message\":$(json_str "$msg")}"
        done | jq -s '.' 2>/dev/null || echo "[]")
        ALL_FINDINGS=$(jq -s 'add' <(echo "$ALL_FINDINGS") <(echo "$TYPE_ERRORS"))
    fi

    # ESLint
    if has_jq && jq -e '.devDependencies.eslint // .dependencies.eslint' "$TARGET_DIR/package.json" >/dev/null 2>&1; then
        LINT_OUTPUT=$(cd "$TARGET_DIR" && npx eslint . --format json 2>/dev/null || echo "[]")
        LINT_ERRORS=$(echo "$LINT_OUTPUT" | jq '[.[] | select(.errorCount > 0) | .filePath as $f | .messages[] | select(.severity == 2) | {
            type: "lint_error",
            file: $f,
            line: .line,
            message: .message,
            rule: .ruleId
        }] | .[0:50]' 2>/dev/null || echo "[]")
        ALL_FINDINGS=$(jq -s 'add' <(echo "$ALL_FINDINGS") <(echo "$LINT_ERRORS"))
    fi

    # npm audit (vulnerabilities)
    AUDIT_OUTPUT=$(cd "$TARGET_DIR" && npm audit --json 2>/dev/null || echo "{}")
    if has_jq; then
        VULNS=$(echo "$AUDIT_OUTPUT" | jq '[
            .vulnerabilities // {} | to_entries[] |
            select(.value.severity == "critical" or .value.severity == "high") |
            {type: "vulnerability", package: .key, severity: .value.severity, message: .value.title}
        ] | .[0:20]' 2>/dev/null || echo "[]")
        ALL_FINDINGS=$(jq -s 'add' <(echo "$ALL_FINDINGS") <(echo "$VULNS"))
    fi

elif [[ -f "$TARGET_DIR/Cargo.toml" ]]; then
    CLIPPY_OUTPUT=$(cd "$TARGET_DIR" && cargo clippy --message-format=json 2>/dev/null || echo "")
    if has_jq && [[ -n "$CLIPPY_OUTPUT" ]]; then
        CLIPPY_FINDINGS=$(echo "$CLIPPY_OUTPUT" | jq -s '[.[] | select(.reason == "compiler-message") | .message | select(.level == "warning" or .level == "error") | {
            type: ("lint_" + .level),
            file: (.spans[0].file_name // "unknown"),
            line: (.spans[0].line_start // 0),
            message: .message
        }] | .[0:50]' 2>/dev/null || echo "[]")
        ALL_FINDINGS=$(jq -s 'add' <(echo "$ALL_FINDINGS") <(echo "$CLIPPY_FINDINGS"))
    fi
fi

# TODO/FIXME scan (all project types)
TODOS=$(grep -rn "TODO\|FIXME\|HACK\|XXX" "$TARGET_DIR/src" "$TARGET_DIR/app" "$TARGET_DIR/lib" 2>/dev/null | grep -v "node_modules" | grep -v ".git" | head -30 | while IFS=: read -r file line_num content; do
    echo "{\"type\":\"todo\",\"file\":$(json_str "$file"),\"line\":$line_num,\"message\":$(json_str "$(echo "$content" | sed 's/^[[:space:]]*//')")}"
done | jq -s '.' 2>/dev/null || echo "[]")
ALL_FINDINGS=$(jq -s 'add' <(echo "$ALL_FINDINGS") <(echo "$TODOS"))

echo "$ALL_FINDINGS"
```

- [ ] **Step 2: 実行権限付与・動作確認**

Run: `chmod +x night-patrol/scripts/scan-lint.sh`
Run: `$SKILLS_DIR/night-patrol/scripts/scan-lint.sh`
Expected: JSON array of findings

- [ ] **Step 3: コミット**

```bash
git add night-patrol/scripts/scan-lint.sh
git commit -m "feat(night-patrol): scan-lint.sh - 静的解析スキャンスクリプト"
```

---

## Task 4: check-duplicates.sh — 重複issue検出

open issueの一覧を取得し、scan結果とのマッチング用データを準備する。LLM が最終判定する前段。

**Files:**
- Create: `night-patrol/scripts/check-duplicates.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# check-duplicates.sh - Fetch open issues for duplicate detection
# Usage: check-duplicates.sh [--label LABEL]
# Output: JSON array of open issues with title, body summary, and labels

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

LABEL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --label) LABEL="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

require_gh_auth

GH_ARGS=(issue list --state open --json "number,title,body,labels" --limit 200)

if [[ -n "$LABEL" ]]; then
    GH_ARGS+=(--label "$LABEL")
fi

ISSUES=$(gh "${GH_ARGS[@]}" 2>/dev/null || echo "[]")

# Truncate body to first 200 chars for efficient LLM comparison
if has_jq; then
    echo "$ISSUES" | jq '[.[] | {
        number: .number,
        title: .title,
        body_summary: (.body[:200] // ""),
        labels: [.labels[].name]
    }]'
else
    echo "$ISSUES"
fi
```

- [ ] **Step 2: 実行権限付与・動作確認**

Run: `chmod +x night-patrol/scripts/check-duplicates.sh`
Run: `$SKILLS_DIR/night-patrol/scripts/check-duplicates.sh`
Expected: JSON array of open issues

- [ ] **Step 3: コミット**

```bash
git add night-patrol/scripts/check-duplicates.sh
git commit -m "feat(night-patrol): check-duplicates.sh - 重複issue検出用データ取得"
```

---

## Task 5: analyze-dependencies.sh — issue間依存解析

issue リストのファイル重複を検出する。LLM が論理依存を判定する前段。

**Files:**
- Create: `night-patrol/scripts/analyze-dependencies.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# analyze-dependencies.sh - Analyze file overlaps between issues
# Usage: analyze-dependencies.sh --issues-json FILE
# Output: JSON with file overlap graph

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

ISSUES_JSON=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issues-json) ISSUES_JSON="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

if [[ -z "$ISSUES_JSON" ]] || [[ ! -f "$ISSUES_JSON" ]]; then
    die_json "Required: --issues-json FILE" 1
fi

require_cmd jq

# Extract estimated_files per issue and build overlap matrix
jq '
  .issues as $issues |
  # Build file -> issues mapping
  reduce ($issues[] | {number, files: .estimated_files} | .number as $num | .files[] | {file: ., issue: $num}) as $entry
    ({}; .[$entry.file] += [$entry.issue]) |
  # Find overlapping files (more than 1 issue touches same file)
  to_entries | map(select(.value | length > 1)) |
  {
    overlaps: [.[] | {file: .key, issues: .value}],
    independent_groups: (
      # Issues that share no files with any other issue
      $issues | map(.number) as $all_issues |
      [.[] | .value[]] | unique as $overlapping_issues |
      [$all_issues[] | select(. as $n | $overlapping_issues | any(. == $n) | not)]
    )
  }
' "$ISSUES_JSON"
```

- [ ] **Step 2: 実行権限付与・動作確認**

Run: `chmod +x night-patrol/scripts/analyze-dependencies.sh`

テスト用の入力ファイルを作って確認:
```bash
echo '{"issues":[{"number":1,"estimated_files":["a.ts","b.ts"]},{"number":2,"estimated_files":["b.ts","c.ts"]},{"number":3,"estimated_files":["d.ts"]}]}' > /tmp/test-issues.json
$SKILLS_DIR/night-patrol/scripts/analyze-dependencies.sh --issues-json /tmp/test-issues.json
```
Expected: `{"overlaps":[{"file":"b.ts","issues":[1,2]}],"independent_groups":[3]}`

- [ ] **Step 3: コミット**

```bash
git add night-patrol/scripts/analyze-dependencies.sh
git commit -m "feat(night-patrol): analyze-dependencies.sh - issue間ファイル重複解析"
```

---

## Task 6: guard-check.sh — 安全ガード判定

設定ファイルからガード条件を読み込み、issueやバッチの安全性をチェックする。

**Files:**
- Create: `night-patrol/scripts/guard-check.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# guard-check.sh - Safety guard checks for night patrol
# Usage: guard-check.sh --mode pre-triage|pre-execute [options]
# Output: JSON with pass/fail and reason

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

MODE=""
FILES=""
LABELS=""
ISSUE_NUMBER=""
CUMULATIVE_LINES=0
ESTIMATED_LINES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode) MODE="$2"; shift 2 ;;
        --files) FILES="$2"; shift 2 ;;
        --labels) LABELS="$2"; shift 2 ;;
        --issue) ISSUE_NUMBER="$2"; shift 2 ;;
        --cumulative-lines) CUMULATIVE_LINES="$2"; shift 2 ;;
        --estimated-lines) ESTIMATED_LINES="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

if [[ -z "$MODE" ]]; then
    die_json "Required: --mode pre-triage|pre-execute" 1
fi

# Load config
CONFIG=$(load_skill_config "night-patrol" 2>/dev/null || echo "{}")
MAX_LINES_PER_ISSUE=$(echo "$CONFIG" | jq -r '.max_lines_per_issue // 500')
MAX_CUMULATIVE=$(echo "$CONFIG" | jq -r '.max_cumulative_lines // 2000')
DENYLIST_PATHS=$(echo "$CONFIG" | jq -r '.denylist_paths // [] | join(",")')
DENYLIST_LABELS=$(echo "$CONFIG" | jq -r '.denylist_labels // [] | join(",")')

PASS=true
REASONS="[]"

case "$MODE" in
    pre-triage)
        # Check denylist paths
        if [[ -n "$FILES" ]] && [[ -n "$DENYLIST_PATHS" ]]; then
            IFS=',' read -ra DENY_PATTERNS <<< "$DENYLIST_PATHS"
            IFS=',' read -ra FILE_LIST <<< "$FILES"
            for file in "${FILE_LIST[@]}"; do
                for pattern in "${DENY_PATTERNS[@]}"; do
                    # shellcheck disable=SC2254
                    case "$file" in
                        $pattern)
                            PASS=false
                            REASONS=$(echo "$REASONS" | jq --arg r "denylist_path: $file matches $pattern" '. + [$r]')
                            ;;
                    esac
                done
            done
        fi

        # Check denylist labels
        if [[ -n "$LABELS" ]] && [[ -n "$DENYLIST_LABELS" ]]; then
            IFS=',' read -ra DENY_LBLS <<< "$DENYLIST_LABELS"
            IFS=',' read -ra LABEL_LIST <<< "$LABELS"
            for label in "${LABEL_LIST[@]}"; do
                for deny in "${DENY_LBLS[@]}"; do
                    if [[ "$label" == "$deny" ]]; then
                        PASS=false
                        REASONS=$(echo "$REASONS" | jq --arg r "denylist_label: $label" '. + [$r]')
                    fi
                done
            done
        fi

        # Check estimated lines
        if [[ "$ESTIMATED_LINES" -gt "$MAX_LINES_PER_ISSUE" ]]; then
            PASS=false
            REASONS=$(echo "$REASONS" | jq --arg r "exceeded_line_limit: $ESTIMATED_LINES > $MAX_LINES_PER_ISSUE" '. + [$r]')
        fi
        ;;

    pre-execute)
        # Check cumulative lines
        if [[ "$CUMULATIVE_LINES" -gt "$MAX_CUMULATIVE" ]]; then
            PASS=false
            REASONS=$(echo "$REASONS" | jq --arg r "exceeded_cumulative: $CUMULATIVE_LINES > $MAX_CUMULATIVE" '. + [$r]')
        fi
        ;;
esac

echo "{\"pass\":$PASS,\"mode\":$(json_str "$MODE"),\"reasons\":$REASONS}"
```

- [ ] **Step 2: 実行権限付与・動作確認**

Run: `chmod +x night-patrol/scripts/guard-check.sh`
Run: `$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-triage --estimated-lines 600`
Expected: `{"pass":false,"mode":"pre-triage","reasons":["exceeded_line_limit: 600 > 500"]}`

Run: `$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute --cumulative-lines 100`
Expected: `{"pass":true,"mode":"pre-execute","reasons":[]}`

- [ ] **Step 3: コミット**

```bash
git add night-patrol/scripts/guard-check.sh
git commit -m "feat(night-patrol): guard-check.sh - 安全ガード判定スクリプト"
```

---

## Task 7: generate-report.sh — レポート生成

night-patrol.json からマークダウンレポートを生成する。

**Files:**
- Create: `night-patrol/scripts/generate-report.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# generate-report.sh - Generate night patrol report from state file
# Usage: generate-report.sh --state FILE --output FILE
# Output: Markdown report path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

STATE_FILE=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --state) STATE_FILE="$2"; shift 2 ;;
        --output) OUTPUT_FILE="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

if [[ -z "$STATE_FILE" ]] || [[ ! -f "$STATE_FILE" ]]; then
    die_json "Required: --state FILE (must exist)" 1
fi

require_cmd jq

STATE=$(cat "$STATE_FILE")
DATE=$(echo "$STATE" | jq -r '.date')
BRANCH=$(echo "$STATE" | jq -r '.branch')
TOTAL=$(echo "$STATE" | jq -r '.issues_total')
COMPLETED=$(echo "$STATE" | jq -r '.issues_completed')
FAILED=$(echo "$STATE" | jq -r '.issues_failed')
SKIPPED=$(echo "$STATE" | jq -r '.issues_skipped')
CUMULATIVE=$(echo "$STATE" | jq -r '.cumulative_lines_changed')

# Default output path
if [[ -z "$OUTPUT_FILE" ]]; then
    REPO_ROOT=$(git_root)
    mkdir -p "$REPO_ROOT/claudedocs/night-patrol"
    OUTPUT_FILE="$REPO_ROOT/claudedocs/night-patrol/$DATE.md"
fi

# Generate report
cat > "$OUTPUT_FILE" << REPORT_EOF
# Night Patrol Report - $DATE

## Summary
- 検出: ${TOTAL}件 → 処理: ${COMPLETED}件完了 / ${SKIPPED}件スキップ / ${FAILED}件失敗
- ブランチ: \`$BRANCH\`
- 累積変更: ${CUMULATIVE}行

## Completed
| Issue | PR | 変更行数 | ステータス |
|-------|-----|---------|-----------|
$(echo "$STATE" | jq -r '.results[] | select(.status == "merged") | "| #\(.issue) | #\(.pr) | \(.lines) | merged |"')

## Skipped
| Issue | 理由 |
|-------|------|
$(echo "$STATE" | jq -r '.results[] | select(.status == "skipped") | "| #\(.issue) | \(.reason) |"')

## Failed
$(echo "$STATE" | jq -r 'if [.results[] | select(.status == "failed")] | length > 0 then
    .results[] | select(.status == "failed") | "| #\(.issue) | \(.reason) |"
else "(なし)" end')

## Next Steps
- [ ] \`$BRANCH\` を確認して dev にマージ
REPORT_EOF

# Add skipped issues as next steps
echo "$STATE" | jq -r '.results[] | select(.status == "skipped") | "- [ ] スキップされた #\(.issue) を手動対応検討 (\(.reason))"' >> "$OUTPUT_FILE"

echo "{\"report_path\":$(json_str "$OUTPUT_FILE"),\"date\":$(json_str "$DATE")}"
```

- [ ] **Step 2: 実行権限付与・動作確認**

テスト用の state ファイルを作成:
```bash
echo '{"date":"2026-04-01","branch":"nightly/2026-04-01","status":"completed","phase":4,"issues_total":3,"issues_completed":2,"issues_failed":0,"issues_skipped":1,"cumulative_lines_changed":150,"results":[{"issue":1,"pr":10,"status":"merged","lines":50},{"issue":2,"pr":11,"status":"merged","lines":100},{"issue":3,"pr":null,"status":"skipped","reason":"exceeded_line_limit","lines":0}]}' > /tmp/test-state.json
```

Run: `chmod +x night-patrol/scripts/generate-report.sh`
Run: `$SKILLS_DIR/night-patrol/scripts/generate-report.sh --state /tmp/test-state.json --output /tmp/test-report.md`
Expected: JSON with report_path, and `/tmp/test-report.md` contains formatted markdown

- [ ] **Step 3: コミット**

```bash
git add night-patrol/scripts/generate-report.sh
git commit -m "feat(night-patrol): generate-report.sh - レポート生成スクリプト"
```

---

## Task 8: references/safety-guards.md — ガード条件の詳細ドキュメント

**Files:**
- Create: `night-patrol/references/safety-guards.md`

- [ ] **Step 1: ドキュメント作成**

```markdown
# Night Patrol Safety Guards

## ガード一覧

### 1. 破壊的変更検出 (triage)

LLM がissue内容と推定ファイルから判定。以下を breaking change と見なす:
- public API の signature 変更（関数名、引数、戻り値型の変更）
- DB migration ファイルの作成・変更
- package.json の major version bump
- 設定ファイルのスキーマ変更

### 2. 1issue変更行数上限 (triage + execute)

- triage 段階: LLM の推定行数が `max_lines_per_issue` (default: 500) を超える場合スキップ
- execute 後: `git diff --stat` の実測値でも再チェック

### 3. denylist パス (triage)

`denylist_paths` のglob パターンにマッチするファイルを含むissueをスキップ。
デフォルト: `.env*`, `*.secret`, `migrations/`

### 4. denylist ラベル (triage)

`denylist_labels` に含まれるラベルが付いたissueをスキップ。
デフォルト: `do-not-autofix`, `needs-discussion`

### 5. denylist issue番号 (scan)

`denylist_issues` に含まれるissue番号を scan 段階で除外。
ユーザーが手動で対応したいissueを指定。

### 6. 累積変更量上限 (execute)

バッチ実行前に `cumulative_lines_changed` が `max_cumulative_lines` (default: 2000) を超えていたら
残りのバッチを全てスキップ。nightly ブランチの差分が大きくなりすぎることを防ぐ。

## ガード発動時の挙動

- スキップされたissueは `night-patrol.json` の `results` に `status: "skipped"` + `reason` で記録
- 累積上限によるループ終了でも Phase 4 (Report) は必ず実行
- Telegram 通知にスキップ数を含める
- ガード発動理由は全て `claudedocs/night-patrol/YYYY-MM-DD.md` にトレース可能
```

- [ ] **Step 2: コミット**

```bash
git add night-patrol/references/safety-guards.md
git commit -m "docs(night-patrol): safety-guards.md - ガード条件詳細ドキュメント"
```

---

## Task 9: SKILL.md — オーケストレーター本体

全フェーズを統合するメインのスキル定義。

**Files:**
- Create: `night-patrol/SKILL.md`

- [ ] **Step 1: Frontmatter + Usage セクション作成**

```markdown
---
name: night-patrol
description: |
  Autonomous code patrol - scan, triage, implement, and report.
  Use when: (1) 自律巡回開発, (2) keywords: night patrol, 夜間巡回, 自動修正, 自律開発
  Accepts args: [scan|triage|execute|report] [--dry-run] [--deep] [--max-issues N]
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Skill
  - Task
  - Agent
  - TaskCreate
  - TaskUpdate
---

# Night Patrol

自律巡回開発 — コードベースをスキャンし、issue発見→作成→実装→PR→nightlyブランチマージを繰り返す。

## Usage

| Command | Description |
|---------|-------------|
| `/night-patrol` | フル実行 (Phase 1-4) |
| `/night-patrol scan` | Phase 1 のみ |
| `/night-patrol scan --deep` | Phase 1 (code-audit-team 使用) |
| `/night-patrol triage` | Phase 2 のみ (scan-results.json 必要) |
| `/night-patrol execute` | Phase 3 のみ (triage-results.json 必要) |
| `/night-patrol report` | Phase 4 のみ (night-patrol.json 必要) |
| `/night-patrol --dry-run` | Phase 1-2 + レポートのみ |
| `/night-patrol --max-issues N` | 処理issue数の上限指定 |
```

- [ ] **Step 2: Workflow Overview + Phase 0 (初期化) 作成**

```markdown
## Workflow

```
Phase 0: Init → Phase 1: Scan → Phase 2: Triage → Phase 3: Execute → Phase 4: Report
```

| Phase | Action | Complete When |
|-------|--------|---------------|
| 0 | 初期化 (nightly branch, state file) | branch created |
| 1 | Scan (scripts or code-audit-team) | scan-results.json exists |
| 2 | Triage (dedup, group, prioritize, plan) | triage-results.json exists |
| 3 | Execute (dev-flow per issue, batch) | all batches processed |
| 4 | Report (markdown + Telegram) | report sent |

## Phase 0: Initialize

1. Load config: `Read skill-config.json` → `night-patrol` section
2. Set DATE to today (`date +%Y-%m-%d`)
3. Create nightly branch:

```bash
git fetch origin dev
git checkout -b nightly/$DATE origin/dev
git push -u origin nightly/$DATE
```

4. Initialize state file `.claude/night-patrol.json`:

```json
{
  "date": "$DATE",
  "branch": "nightly/$DATE",
  "status": "initialized",
  "phase": 0,
  "issues_total": 0,
  "issues_completed": 0,
  "issues_failed": 0,
  "issues_skipped": 0,
  "cumulative_lines_changed": 0,
  "results": []
}
```

5. If subcommand specified (`scan`, `triage`, `execute`, `report`), jump to that Phase directly.
```

- [ ] **Step 3: Phase 1 (Scan) セクション作成**

```markdown
## Phase 1: Scan

Update state: `phase: 1, status: "scanning"`

### Normal mode (default)

Run 3 scan scripts in parallel:

```bash
$SKILLS_DIR/night-patrol/scripts/scan-lint.sh
$SKILLS_DIR/night-patrol/scripts/scan-tests.sh
$SKILLS_DIR/night-patrol/scripts/scan-issues.sh \
  --allowed-labels "$CONFIG.allowed_labels" \
  --denylist-labels "$CONFIG.denylist_labels" \
  --denylist-issues "$CONFIG.denylist_issues"
```

### --deep mode

Additionally invoke:
```
Skill(skill: "code-audit-team", args: "--scope project")
```

Parse code-audit-team output and extract findings into `audit` source.

### Merge results

Combine all script outputs into `.claude/scan-results.json`:

```json
{
  "scan_date": "<ISO timestamp>",
  "mode": "normal|deep",
  "sources": {
    "lint": [<scan-lint.sh output>],
    "tests": [<scan-tests.sh output>],
    "issues": [<scan-issues.sh output>],
    "audit": [<code-audit-team findings if --deep>]
  },
  "counts": {"lint": N, "tests": N, "issues": N, "audit": N, "total": N}
}
```

If subcommand is `scan`, stop here.
```

- [ ] **Step 4: Phase 2 (Triage) セクション作成**

```markdown
## Phase 2: Triage

Update state: `phase: 2, status: "triaging"`

Read `.claude/scan-results.json`.

### Step 1: Duplicate check

```bash
$SKILLS_DIR/night-patrol/scripts/check-duplicates.sh
```

LLM compares each scan finding (lint/tests/audit sources) against open issues:
- **Duplicate**: skip, add existing issue number to processing list
- **Partial duplicate**: add comment to existing issue via `gh issue comment`, skip
- **New**: proceed to grouping

### Step 2: Grouping (A/B/audit sources only)

LLM groups related findings into logical issues:
- Same file, same category → 1 issue
- Related files, same root cause → 1 issue
- Each group gets a title and description

### Step 3: Safety guard filter

For each candidate issue, run:
```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-triage \
  --files "file1.ts,file2.ts" \
  --labels "label1,label2" \
  --estimated-lines N
```

If `pass: false` → add to skipped list with reasons.

LLM also checks for breaking changes (public API changes, DB migrations).

### Step 4: Priority scoring

LLM assigns priority to each issue:
| Priority | Criteria |
|----------|----------|
| critical | Test failures, security vulnerabilities |
| high | Type errors, bug issues |
| medium | Lint warnings, enhancement issues |
| low | TODO/FIXME, cosmetic |

### Step 5: Dependency analysis

```bash
$SKILLS_DIR/night-patrol/scripts/analyze-dependencies.sh --issues-json .claude/triage-issues.json
```

LLM adds logical dependency analysis on top of file overlap data.
Generates execution plan with parallel batches and serial chains.

### Step 6: Issue creation

For new findings only (not existing GitHub issues):
```bash
gh issue create --title "TITLE" --body "BODY" --label "night-patrol,PRIORITY"
```

### Output

Write `.claude/triage-results.json` with issues, execution_plan, skipped, stats.

If `--dry-run` flag, skip to Phase 4 (Report) instead of Phase 3.
If subcommand is `triage`, stop here.
```

- [ ] **Step 5: Phase 3 (Execute) セクション作成**

```markdown
## Phase 3: Execute

Update state: `phase: 3, status: "executing"`

Read `.claude/triage-results.json`.

Apply `--max-issues` limit if set (take first N issues from execution plan).

### Batch loop

For each batch in `execution_plan.batches` (ordered by batch number):

1. **Pre-execute guard check:**
```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute \
  --cumulative-lines $CUMULATIVE
```
If `pass: false` → skip all remaining batches, proceed to Phase 4.

2. **Execute batch:**

**Parallel batch** (`mode: "parallel"`):
Launch each issue as a Task subagent:
```
Task: dev-flow <issue-number> --base nightly/$DATE
```
Wait for all to complete.

**Serial batch** (`mode: "serial"`):
Execute each issue sequentially:
```
Skill(skill: "dev-flow", args: "<issue-number> --base nightly/$DATE")
```

3. **Process results:**

For each completed issue:
- If dev-flow returned LGTM PR → merge PR into `nightly/$DATE`
  ```bash
  gh pr merge <PR_NUMBER> --merge
  ```
- If max_reached or error → record as skipped/failed

4. **Update state:** Add result to `results[]`, update counters.

### After all batches

Update state: `status: "completed"`

If subcommand is `execute`, stop here.
```

- [ ] **Step 6: Phase 4 (Report) セクション作成**

```markdown
## Phase 4: Report

Update state: `phase: 4, status: "reporting"`

### Generate report

```bash
$SKILLS_DIR/night-patrol/scripts/generate-report.sh \
  --state .claude/night-patrol.json
```

### Telegram notification

Load `telegram_chat_id` from config. If set:

```
telegram reply --chat_id $CHAT_ID --text "Night Patrol 完了

${COMPLETED}件完了 / ${SKIPPED}件スキップ / ${FAILED}件失敗
${CUMULATIVE}行変更 (nightly/$DATE)

→ レポート: claudedocs/night-patrol/$DATE.md"
```

### Journal logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log night-patrol success \
  --context "scanned=$TOTAL,processed=$COMPLETED,skipped=$SKIPPED,failed=$FAILED"
```

Update state: `status: "done"`

Details: [Safety Guards](references/safety-guards.md)
```

- [ ] **Step 7: 全セクションを night-patrol/SKILL.md に結合して書き出し**

上記 Step 1-6 の内容を1つの SKILL.md ファイルとして結合・書き出し。

- [ ] **Step 8: コミット**

```bash
git add night-patrol/SKILL.md
git commit -m "feat(night-patrol): SKILL.md - オーケストレーター本体"
```

---

## Task 10: 統合テスト — dry-run で Phase 1-2 を実行

実際のリポジトリで `/night-patrol --dry-run` を実行し、Phase 1-2 が正しく動作することを確認する。

**Files:**
- (既存ファイルのバグ修正のみ)

- [ ] **Step 1: scan スクリプト群の単体テスト**

各スクリプトを個別に実行し、JSONが正しく出力されることを確認:

```bash
$SKILLS_DIR/night-patrol/scripts/scan-issues.sh
$SKILLS_DIR/night-patrol/scripts/scan-tests.sh
$SKILLS_DIR/night-patrol/scripts/scan-lint.sh
```

全て正常なJSONを返すことを確認。エラーがあれば修正。

- [ ] **Step 2: guard-check.sh のエッジケーステスト**

```bash
# pass するケース
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-triage --estimated-lines 100
# fail するケース
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-triage --files ".env.local" --estimated-lines 100
# cumulative チェック
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute --cumulative-lines 3000
```

- [ ] **Step 3: `/night-patrol scan` でPhase 1 を実行**

`/night-patrol scan` を実行し、`.claude/scan-results.json` が正しく生成されることを確認。

- [ ] **Step 4: `/night-patrol --dry-run` でPhase 1-2 を実行**

`/night-patrol --dry-run` を実行し:
- scan-results.json が生成される
- triage-results.json が生成される
- execution_plan にバッチが含まれる
- レポートが出力される（Phase 3 はスキップ）

- [ ] **Step 5: 発見した問題の修正・コミット**

テスト中に発見した問題を修正:

```bash
git add -A
git commit -m "fix(night-patrol): 統合テストで発見した問題を修正"
```

---

## Task 11: dev-flow の --base オプション確認・対応

dev-flow / git-pr がベースブランチ指定に対応しているか確認し、必要なら対応する。

**Files:**
- Possibly modify: `git-pr/SKILL.md`, `git-pr/scripts/create-pr.sh`

- [ ] **Step 1: git-pr の --base オプション確認**

```bash
grep -n "base" $SKILLS_DIR/git-pr/SKILL.md
grep -n "base" $SKILLS_DIR/git-pr/scripts/create-pr.sh
```

git-pr が `--base` を受け付けるか確認。受け付ける場合はこのタスク完了。

- [ ] **Step 2: (必要な場合のみ) --base オプション追加**

git-pr / create-pr.sh に `--base` オプションが無い場合、追加する。
既存のデフォルト (`dev`) は変更しない。

- [ ] **Step 3: コミット**

```bash
git add git-pr/
git commit -m "feat(git-pr): --base オプション追加 (night-patrol連携用)"
```

---

## Summary

| Task | 内容 | ファイル数 |
|------|------|-----------|
| 1 | scan-issues.sh | 1 |
| 2 | scan-tests.sh | 1 |
| 3 | scan-lint.sh | 1 |
| 4 | check-duplicates.sh | 1 |
| 5 | analyze-dependencies.sh | 1 |
| 6 | guard-check.sh | 1 |
| 7 | generate-report.sh | 1 |
| 8 | safety-guards.md | 1 |
| 9 | SKILL.md | 1 |
| 10 | 統合テスト | 0 (バグ修正のみ) |
| 11 | dev-flow --base 確認 | 0-1 |
| **合計** | | **9-10 ファイル** |
