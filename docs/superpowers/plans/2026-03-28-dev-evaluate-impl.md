# dev-evaluate GAN 型 Evaluator Agent 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dev-flow に GAN 型 Generator/Evaluator 分離パターンを導入し、commit 前に独立した品質評価ループを実現する

**Architecture:** 新規スキル dev-evaluate（Opus Evaluator）と dev-plan-impl（Opus Planner）を追加し、dev-kickoff の Phase を 6→8 に拡張。dev-implement は Sonnet に変更し、Evaluator の feedback でリトライループを形成する。

**Tech Stack:** Bash (scripts), Markdown (SKILL.md/references), JSON (schemas/config)

**Spec:** `docs/superpowers/specs/2026-03-28-dev-evaluate-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `dev-evaluate/SKILL.md` | Evaluator ス���ル定義 — ワークフロー、スコアリング指示 |
| `dev-evaluate/scripts/detect-task-type.sh` | diff + issue タイプからタスクタイプを推定 |
| `dev-evaluate/references/scoring-framework.md` | 共通 + タイプ別スコアリング基準の詳細 |
| `dev-evaluate/references/evaluation-strategies.md` | タイプ別評価戦略 + Phase 2 拡張ポイント |
| `dev-plan-impl/SKILL.md` | 実装計画スキル定義 — 計画書生成ワークフロー |
| `dev-plan-impl/references/plan-format.md` | 計画書フォーマット仕様 |

### Modified Files

| File | Changes |
|------|---------|
| `_lib/schemas/kickoff.schema.json` | version 3.0.0, 8 phases, evaluate iterations |
| `dev-kickoff/scripts/init-kickoff.sh` | 8 phases 初期化, evaluate 固有フィールド |
| `dev-kickoff/scripts/update-phase.sh` | VALID_PHASES 更新, phase 遷移ロジック |
| `dev-kickoff/scripts/next-action.sh` | 8 phases の遷移マップ |
| `dev-kickoff/SKILL.md` | Phase テーブル + リトライループ + Parallel Mode |
| `dev-implement/SKILL.md` | impl-plan.md 読み込み + feedback 入力対応 |
| `skill-config.json` | dev-evaluate, dev-plan-impl, dev-implement 設定 |

---

## Task 1: kickoff.schema.json を v3.0.0 に更新

**Files:**
- Modify: `_lib/schemas/kickoff.schema.json`

- [ ] **Step 1: スキーマの version を更新**

`version.const` を `"1.0.0"` → `"3.0.0"` に変更。

- [ ] **Step 2: phases に新 Phase を追加**

`phases.properties` に以下を追加:
- `3_plan_impl` — `$ref: #/$defs/phase`
- `6_evaluate` — 独自スキーマ（iterations 配列を持つ）

既存 phases の番号をシフト:
- `3_implement` → `4_implement`
- `4_validate` → `5_validate`
- `5_commit` → `7_commit`
- `6_pr` → `8_pr`

- [ ] **Step 3: evaluate phase の独自スキーマを定義**

`$defs` に `evaluate_phase` を追加:

```json
{
  "evaluate_phase": {
    "type": "object",
    "properties": {
      "status": { "type": "string", "enum": ["pending", "in_progress", "done", "failed", "skipped"] },
      "started_at": { "type": "string", "format": "date-time" },
      "completed_at": { "type": "string", "format": "date-time" },
      "iterations": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "iteration": { "type": "integer" },
            "verdict": { "type": "string", "enum": ["pass", "fail"] },
            "total": { "type": "number" },
            "feedback_level": { "type": "string", "enum": ["implementation", "design"] },
            "feedback": { "type": "array", "items": { "type": "string" } },
            "task_type": { "type": "string" },
            "timestamp": { "type": "string", "format": "date-time" }
          },
          "required": ["iteration", "verdict", "total", "timestamp"]
        }
      },
      "current_iteration": { "type": "integer", "default": 0 },
      "max_iterations": { "type": "integer", "default": 5 },
      "error": { "type": "string" }
    },
    "required": ["status"]
  }
}
```

- [ ] **Step 4: current_phase enum を更新**

```json
"enum": ["1_prepare", "2_analyze", "3_plan_impl", "4_implement", "5_validate", "6_evaluate", "7_commit", "8_pr", "completed"]
```

- [ ] **Step 5: config に testing/design フィールドを追加**

既存の `config.properties.strategy` を**削除**し、`testing` と `design` に分離（init-kickoff.sh の出力と合わせる）:

```json
"testing": { "type": "string", "enum": ["tdd", "bdd", "none"] },
"design": { "type": ["string", "null"], "enum": ["ddd", null] }
```

旧 `strategy` フィールドは削除すること。

- [ ] **Step 6: 検証 — jq でスキーマの JSON 構文チェック**

Run: `jq . _lib/schemas/kickoff.schema.json > /dev/null`
Expected: exit 0, no output

- [ ] **Step 7: Commit**

```bash
git add _lib/schemas/kickoff.schema.json
git commit -m "feat(schemas): kickoff.schema.json を v3.0.0 に更新 — 8 Phase + evaluate iterations"
```

---

## Task 2: init-kickoff.sh を 8 Phase 対応に更新

**Files:**
- Modify: `dev-kickoff/scripts/init-kickoff.sh`

- [ ] **Step 1: version を 3.0.0 に更新**

jq テンプレート内の `version: "2.0.0"` → `version: "3.0.0"` に変更。

- [ ] **Step 2: phases を 8 Phase に更新**

jq テンプレートの `phases` オブジェクトを更新:

```
"1_prepare": done (現状通り)
"2_analyze": pending
"3_plan_impl": pending          ← 新規
"4_implement": pending          ← 旧 3_implement
"5_validate": pending           ← 旧 4_validate
"6_evaluate": pending + iterations: [], current_iteration: 0, max_iterations: 5  ← 新規
"7_commit": pending             ← 旧 5_commit
"8_pr": pending                 ← 旧 6_pr
```

`max_iterations` のデフォルト値 5 は、将来的に skill-config.json から読み取る。
現時点ではハードコード（後続タスクで config 読み取り対応可能）。

- [ ] **Step 3: current_phase の初期値を確認**

`current_phase: "1_prepare"` のまま変更不要（Phase 1 が done なので next-action で 2_analyze に遷移）。

- [ ] **Step 4: 検証 — ドライラン**

Run: `bash dev-kickoff/scripts/init-kickoff.sh 999 test-branch /tmp/test-wt --base main 2>&1 || true`

（/tmp/test-wt が存在しないのでエラーになるが、構文エラーがないことを確認）

テスト用の一時ディレクトリで実行:

```bash
mkdir -p /tmp/test-kickoff-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-kickoff-wt --base main && \
jq '.phases | keys' /tmp/test-kickoff-wt/.claude/kickoff.json && \
jq '.version' /tmp/test-kickoff-wt/.claude/kickoff.json && \
rm -rf /tmp/test-kickoff-wt
```

Expected:
```json
["1_prepare", "2_analyze", "3_plan_impl", "4_implement", "5_validate", "6_evaluate", "7_commit", "8_pr"]
"3.0.0"
```

- [ ] **Step 5: Commit**

```bash
git add dev-kickoff/scripts/init-kickoff.sh
git commit -m "feat(dev-kickoff): init-kickoff.sh を 8 Phase 対応に更新"
```

---

## Task 3: update-phase.sh を 8 Phase + ステータスリセット対応に更新

**Files:**
- Modify: `dev-kickoff/scripts/update-phase.sh`

- [ ] **Step 1: VALID_PHASES を更新**

```bash
VALID_PHASES="1_prepare 2_analyze 3_plan_impl 4_implement 5_validate 6_evaluate 7_commit 8_pr"
```

- [ ] **Step 2: Phase 遷移ロジック（done 時の current_phase 更新）を更新**

`case "$PHASE"` の done 時の遷移:

```bash
1_prepare)  next="2_analyze" ;;
2_analyze)  next="3_plan_impl" ;;
3_plan_impl) next="4_implement" ;;
4_implement) next="5_validate" ;;
5_validate) next="6_evaluate" ;;
6_evaluate) next="7_commit" ;;
7_commit)   next="8_pr" ;;
8_pr)       next="completed" ;;
```

- [ ] **Step 3: `--reset-to` オプションを追加**

リトライ時の Phase ステータスリセット用。指定した Phase 以降を pending にリセットする:

```bash
--reset-to) RESET_TO="$2"; shift 2 ;;
```

処理:

注: `--reset-to` は必ず `done` ステータスと組み合わせて使う。
通常の done 遷移が先に適用された後、reset がそれを上書きする。

```bash
if [[ -n "$RESET_TO" ]]; then
    # Reset phases from RESET_TO onwards to pending
    # NOTE: No `local` keyword - this runs in main script body, not a function
    PHASE_ORDER=("3_plan_impl" "4_implement" "5_validate" "6_evaluate")
    resetting=false
    for p in "${PHASE_ORDER[@]}"; do
        if [[ "$p" == "$RESET_TO" ]]; then
            resetting=true
        fi
        if [[ "$resetting" == true ]]; then
            JQ_FILTER="$JQ_FILTER | .phases[\"$p\"].status = \"pending\""
        fi
    done
    # Override the normal phase transition set by `done`
    JQ_FILTER="$JQ_FILTER | .current_phase = \"$RESET_TO\""
fi
```

- [ ] **Step 4: 6_evaluate の iterations 書き込みサポート**

`--eval-result` オプション追加。JSON 文字列を受け取り `6_evaluate.iterations[]` に追記:

```bash
--eval-result) EVAL_RESULT="$2"; shift 2 ;;
```

処理:

```bash
if [[ -n "$EVAL_RESULT" ]]; then
    JQ_ARGS+=(--argjson eval_result "$EVAL_RESULT")
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].iterations += [\$eval_result]"
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].current_iteration += 1"
fi
```

- [ ] **Step 5: 検証 — 基本動作テスト**

```bash
mkdir -p /tmp/test-update-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-update-wt --base main && \
bash dev-kickoff/scripts/update-phase.sh 2_analyze in_progress --worktree /tmp/test-update-wt && \
bash dev-kickoff/scripts/update-phase.sh 2_analyze done --result "Analyzed" --worktree /tmp/test-update-wt && \
jq '.current_phase' /tmp/test-update-wt/.claude/kickoff.json && \
rm -rf /tmp/test-update-wt
```

Expected: `"3_plan_impl"`

- [ ] **Step 6: 検証 — reset-to テスト**

```bash
mkdir -p /tmp/test-reset-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-reset-wt --base main && \
bash dev-kickoff/scripts/update-phase.sh 3_plan_impl done --result "Planned" --worktree /tmp/test-reset-wt && \
bash dev-kickoff/scripts/update-phase.sh 4_implement done --result "Implemented" --worktree /tmp/test-reset-wt && \
bash dev-kickoff/scripts/update-phase.sh 5_validate done --result "Validated" --worktree /tmp/test-reset-wt && \
bash dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 4_implement --worktree /tmp/test-reset-wt && \
jq '{current: .current_phase, impl: .phases["4_implement"].status, val: .phases["5_validate"].status, eval: .phases["6_evaluate"].status}' /tmp/test-reset-wt/.claude/kickoff.json && \
rm -rf /tmp/test-reset-wt
```

Expected:
```json
{"current": "4_implement", "impl": "pending", "val": "pending", "eval": "pending"}
```

- [ ] **Step 7: Commit**

```bash
git add dev-kickoff/scripts/update-phase.sh
git commit -m "feat(dev-kickoff): update-phase.sh を 8 Phase + --reset-to 対応に更新"
```

---

## Task 4: next-action.sh を 8 Phase 遷移に更新

**Files:**
- Modify: `dev-kickoff/scripts/next-action.sh`

- [ ] **Step 1: 新 Phase の状態読み取り変数を追加**

`TESTING`, `DESIGN` に加えて impl-plan パスも出力に含めるため不要（LLM が判断する）。

- [ ] **Step 2: determine_next_action の case 文を更新**

全 8 Phase + completed の遷移マップ。既存の done/not-done 分岐パターンを踏襲する:

```bash
case "$CURRENT_PHASE" in
    1_prepare)
        local status=$(get_phase_status "1_prepare")
        if [[ "$status" == "done" ]]; then
            echo "2_analyze"
            echo "Skill: dev-issue-analyze $ISSUE --depth $DEPTH"
        else
            echo "1_prepare"
            echo "$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE_BRANCH"
        fi
        ;;
    2_analyze)
        local status=$(get_phase_status "2_analyze")
        if [[ "$status" == "done" ]]; then
            echo "3_plan_impl"
            echo "Skill: dev-plan-impl $ISSUE --worktree $WORKTREE"
        else
            echo "2_analyze"
            echo "Skill: dev-issue-analyze $ISSUE --depth $DEPTH"
        fi
        ;;
    3_plan_impl)
        local status=$(get_phase_status "3_plan_impl")
        if [[ "$status" == "done" ]]; then
            echo "4_implement"
            echo "Skill: dev-implement --testing $TESTING${DESIGN:+ --design $DESIGN} --worktree $WORKTREE"
        else
            echo "3_plan_impl"
            echo "Skill: dev-plan-impl $ISSUE --worktree $WORKTREE"
        fi
        ;;
    4_implement)
        local status=$(get_phase_status "4_implement")
        if [[ "$status" == "done" ]]; then
            echo "5_validate"
            echo "Skill: dev-validate --fix --worktree $WORKTREE"
        else
            echo "4_implement"
            echo "Skill: dev-implement --testing $TESTING${DESIGN:+ --design $DESIGN} --worktree $WORKTREE"
        fi
        ;;
    5_validate)
        local status=$(get_phase_status "5_validate")
        if [[ "$status" == "done" ]]; then
            echo "6_evaluate"
            echo "Skill: dev-evaluate $ISSUE --worktree $WORKTREE"
        else
            echo "5_validate"
            echo "Skill: dev-validate --fix --worktree $WORKTREE"
        fi
        ;;
    6_evaluate)
        local status=$(get_phase_status "6_evaluate")
        if [[ "$status" == "done" ]]; then
            echo "7_commit"
            echo "Skill: git-commit --all --worktree $WORKTREE"
        else
            echo "6_evaluate"
            echo "Skill: dev-evaluate $ISSUE --worktree $WORKTREE"
        fi
        ;;
    7_commit)
        local status=$(get_phase_status "7_commit")
        if [[ "$status" == "done" ]]; then
            echo "8_pr"
            echo "Skill: git-pr $ISSUE --base $BASE_BRANCH --lang $LANG --worktree $WORKTREE"
        else
            echo "7_commit"
            echo "Skill: git-commit --all --worktree $WORKTREE"
        fi
        ;;
    8_pr)
        local status=$(get_phase_status "8_pr")
        if [[ "$status" == "done" ]]; then
            echo "pr-iterate"
            if [[ -n "$PR_URL" ]]; then
                echo "Skill: pr-iterate $PR_URL"
            else
                echo "Skill: pr-iterate $PR_NUMBER"
            fi
        else
            echo "8_pr"
            echo "Skill: git-pr $ISSUE --base $BASE_BRANCH --lang $LANG --worktree $WORKTREE"
        fi
        ;;
    completed)
        if [[ -n "$PR_URL" ]]; then
            echo "pr-iterate"
            echo "Skill: pr-iterate $PR_URL"
        else
            echo "completed"
            echo "Workflow complete"
        fi
        ;;
    *)
        echo "unknown"
        echo "Unknown state - check kickoff.json"
        ;;
esac
```

注: リトライループの分岐（evaluate fail → 3_plan_impl or 4_implement に戻る）は
LLM（dev-kickoff の SKILL.md）が判断する。next-action.sh は単純な線形遷移のみ。

- [ ] **Step 3: 検証 — 遷移テスト**

```bash
mkdir -p /tmp/test-next-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-next-wt --base main && \
bash dev-kickoff/scripts/update-phase.sh 2_analyze done --result "Done" --worktree /tmp/test-next-wt && \
bash dev-kickoff/scripts/next-action.sh --worktree /tmp/test-next-wt | jq '.next_phase' && \
rm -rf /tmp/test-next-wt
```

Expected: `"3_plan_impl"`

- [ ] **Step 4: Commit**

```bash
git add dev-kickoff/scripts/next-action.sh
git commit -m "feat(dev-kickoff): next-action.sh を 8 Phase 遷移に更新"
```

---

## Task 5: dev-evaluate スキルを新規作成

**Files:**
- Create: `dev-evaluate/SKILL.md`
- Create: `dev-evaluate/scripts/detect-task-type.sh`
- Create: `dev-evaluate/references/scoring-framework.md`
- Create: `dev-evaluate/references/evaluation-strategies.md`

- [ ] **Step 1: ディレクトリ作成**

```bash
mkdir -p dev-evaluate/scripts dev-evaluate/references
```

- [ ] **Step 2: detect-task-type.sh を作成**

issue タイプ（analyze 結果）を第一優先、diff パターンを第二優先としてタスクタイプを判定:

```bash
#!/usr/bin/env bash
# detect-task-type.sh - Detect task type from issue type and diff patterns
# Usage: detect-task-type.sh --worktree <path> [--issue-type <type>]
# Output: JSON { "task_type": "frontend|api|refactor|infrastructure|generic", "source": "issue|diff" }

set -euo pipefail

WORKTREE=""
ISSUE_TYPE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --issue-type) ISSUE_TYPE="$2"; shift 2 ;;
        *) shift ;;
    esac
done

[[ -n "$WORKTREE" ]] || { echo '{"task_type":"generic","source":"default"}'; exit 0; }

# Priority 1: Issue type from dev-issue-analyze
if [[ -n "$ISSUE_TYPE" ]]; then
    case "$ISSUE_TYPE" in
        refactor*) echo '{"task_type":"refactor","source":"issue"}'; exit 0 ;;
    esac
fi

# Priority 2: Diff file pattern analysis
cd "$WORKTREE" 2>/dev/null || { echo '{"task_type":"generic","source":"default"}'; exit 0; }

DIFF_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null || echo "")

if [[ -z "$DIFF_FILES" ]]; then
    echo '{"task_type":"generic","source":"default"}'
    exit 0
fi

# Count files matching each pattern
FRONTEND_COUNT=$(echo "$DIFF_FILES" | grep -cE '(components/|\.tsx$|\.vue$|\.svelte$|\.css$|\.scss$)' || echo 0)
API_COUNT=$(echo "$DIFF_FILES" | grep -cE '(routes/|api/|controller|handler|endpoint|\.resolver\.)' || echo 0)
INFRA_COUNT=$(echo "$DIFF_FILES" | grep -cE '(Dockerfile|\.tf$|\.ya?ml$|\.toml$|helm/|k8s/|\.github/)' || echo 0)
TOTAL=$(echo "$DIFF_FILES" | wc -l | tr -d ' ')

# Determine by majority
if [[ "$FRONTEND_COUNT" -gt 0 && "$FRONTEND_COUNT" -ge "$API_COUNT" && "$FRONTEND_COUNT" -ge "$INFRA_COUNT" ]]; then
    echo '{"task_type":"frontend","source":"diff"}'
elif [[ "$API_COUNT" -gt 0 && "$API_COUNT" -ge "$FRONTEND_COUNT" && "$API_COUNT" -ge "$INFRA_COUNT" ]]; then
    echo '{"task_type":"api","source":"diff"}'
elif [[ "$INFRA_COUNT" -gt 0 && "$INFRA_COUNT" -ge "$FRONTEND_COUNT" && "$INFRA_COUNT" -ge "$API_COUNT" ]]; then
    echo '{"task_type":"infrastructure","source":"diff"}'
else
    echo '{"task_type":"generic","source":"diff"}'
fi
```

権限: `chmod +x dev-evaluate/scripts/detect-task-type.sh`

- [ ] **Step 3: scoring-framework.md を作成**

spec のスコアリングフレームワークセクション（lines 223-271）の詳細版。以下を含む:

1. **共通基準**（spec lines 225-231）: requirements, code_quality, edge_cases の各 1-10 スコアリングガイド
   - 各スコアレベルの具体例（例: requirements 10 = 全受入基準を完全に満たす, 5 = 主要機能は動くがエッジケース未対応, 1 = 要件の半分以上が未実装）
2. **タイプ別追加基準**（spec lines 233-241）: frontend/api/refactor/infrastructure の各追加基準
3. **スコア算出式**（spec lines 243-251）: `total = (共通平均 × 0.7) + (タイプ別 × 0.3)`, generic は共通平均のみ
4. **閾値**: デフォルト 7.0（この非対称性は意図的: タイプ別基準がある場合はタイプ固有の品質も求める）
5. **feedback_level 判定基準**: 「設計レベル」と「実装レベル」の分類例

- [ ] **Step 4: evaluation-strategies.md を作成**

spec の拡張ポイントセクション（lines 432-462）の内容。以下の構造:

```markdown
# Evaluation Strategies

## Strategy Interface

| Field | Description |
|-------|-------------|
| type | タスクタイプ識別子 |
| static_review | コードレビューベースの評価指示（Phase 1、常に実行） |
| runtime_review | 実行環境での検証指示（Phase 2、オプション、null = 未実装） |

## frontend
- static_review: コンポーネント構造、props設計、アクセシビリティ属性（aria-*）、レスポンシブ対応の確認
- runtime_review: null (Phase 2: Playwright でスクリーンショット + インタラクション検証)

## api
- static_review: エンドポイント設計（REST規約）、エラーハンドリング（4xx/5xx）、バリデーション、認証/認可の確認
- runtime_review: null (Phase 2: curl でレスポンス検証)

## refactor
- static_review: 振る舞い保持の diff 分析、テストカバレッジ維持、public API 変更なし、破壊的変更なし
- runtime_review: null

## infrastructure
- static_review: 冪等性、セキュリティ設定（secrets expose なし）、ロールバック可能性の確認
- runtime_review: null

## generic
- static_review: 共通基準のみで評価
- runtime_review: null
```

- [ ] **Step 5: SKILL.md を作成**

Frontmatter:

```yaml
---
name: dev-evaluate
description: |
  Evaluate implementation quality as independent agent (GAN-style Evaluator).
  Use when: (1) post-implementation quality gate, (2) dev-kickoff Phase 6,
  (3) keywords: evaluate, 評価, quality gate, レビュー
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
context: fork
agent: general-purpose
---
```

本文のワークフロー:

```
1. 入力収集（kickoff.json, impl-plan.md, git diff, validate 結果）
2. タスクタイプ検出（detect-task-type.sh）
3. 評価戦略読み込み（references/evaluation-strategies.md）
4. スコアリング実行（references/scoring-framework.md の基準に従う）
5. verdict 判定（total >= threshold → pass, otherwise → fail）
6. feedback_level 判定（設計/実装レベルの分類）
7. JSON 結果を stdout に出力
```

- [ ] **Step 6: 検証 — detect-task-type.sh 構文チェック**

```bash
bash -n dev-evaluate/scripts/detect-task-type.sh && echo "OK"
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add dev-evaluate/
git commit -m "feat(dev-evaluate): GAN型Evaluatorスキルを新規作成"
```

---

## Task 6: dev-plan-impl スキルを新規作成

**Files:**
- Create: `dev-plan-impl/SKILL.md`
- Create: `dev-plan-impl/references/plan-format.md`

- [ ] **Step 1: ディレクトリ作成**

```bash
mkdir -p dev-plan-impl/references
```

- [ ] **Step 2: plan-format.md を作成**

impl-plan.md のフォーマット仕様:

```markdown
# Implementation Plan Format

## Output Path

`$WORKTREE/.claude/impl-plan.md`

## Template

# Implementation Plan

## Overview
[1-2文: 何を、なぜ実装するか]

## File Changes
| File | Action | Description |
|------|--------|-------------|
| path/to/file | create/modify/delete | 変更内容 |

## Architecture Decisions
- [設計判断とその理由]

## Edge Cases
- [考慮すべきエッジケース]

## Dependencies
- [外部ライブラリ、内部モジュール依存]

## Notes for Retry
[Evaluator feedback があれば、それに対する対応方針]
```

- [ ] **Step 3: SKILL.md を作成**

Frontmatter:

```yaml
---
name: dev-plan-impl
description: |
  Create implementation plan from issue analysis (Opus planner).
  Use when: (1) dev-kickoff Phase 3, (2) implementation planning before coding,
  (3) keywords: 実装計画, implementation plan, design plan
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
---
```

本文のワークフロー:

```
1. 入力読み取り（kickoff.json の analyze 結果、コードベース構造）
2. feedback 確認（リトライ時: 前回の Evaluator feedback を読む）
3. 実装計画策定（ファイル変更一覧、設計判断、エッジケース）
4. $WORKTREE/.claude/impl-plan.md に出力
```

- [ ] **Step 4: 検証 — SKILL.md frontmatter 確認**

```bash
head -15 dev-plan-impl/SKILL.md
```

model: opus と allowed-tools が正しいことを目視確認。

- [ ] **Step 5: Commit**

```bash
git add dev-plan-impl/
git commit -m "feat(dev-plan-impl): Opus Plannerスキルを新規作成"
```

---

## Task 7: dev-implement の SKILL.md を更新

**Files:**
- Modify: `dev-implement/SKILL.md`

- [ ] **Step 1: frontmatter に `model: sonnet` を追加**

既存の frontmatter（`---` ブロック内）に `model: sonnet` を追加。
これにより dev-kickoff から呼び出された際に Sonnet モデルで実行される。
standalone 実行時も Sonnet だが、skill-config.json で上書き可能。

```yaml
model: sonnet
```

- [ ] **Step 2: impl-plan.md 読み込みステップを追加**

Workflow の Step 3 (Plan) を変更。`$WORKTREE/.claude/impl-plan.md` が存在する場合は
それに従い、存在しない場合（standalone 実行時）は従来通り自分で計画する:

Step 3 の冒頭に追加:

```markdown
### Step 3: Plan Implementation

**impl-plan.md Check**: If `$WORKTREE/.claude/impl-plan.md` exists (created by dev-plan-impl),
follow that plan. Do not re-plan from scratch. If the plan has a "Notes for Retry" section,
address the feedback noted there.

If `impl-plan.md` does NOT exist (standalone invocation), plan as before:
```

- [ ] **Step 3: Evaluator feedback 読み取りの説明を追加**

Step 3 (Plan) の後に注記を追加:

```markdown
**Evaluator Feedback (retry mode)**: On retry, read `kickoff.json` → `phases.6_evaluate.iterations[]`
for the latest feedback. The `feedback` array contains specific issues to address.
The `feedback_level` indicates whether the issues are design-level (re-plan needed)
or implementation-level (re-implement within existing plan).
```

- [ ] **Step 4: Integration セクションを更新**

既存の Integration セクションに追加:

```markdown
- Reads `$WORKTREE/.claude/impl-plan.md` from `dev-plan-impl` if available
- Receives Evaluator feedback via kickoff.json iterations on retry
```

- [ ] **Step 5: 検証 — frontmatter の model フィールド確認**

```bash
head -15 dev-implement/SKILL.md | grep "model:"
```

Expected: `model: sonnet`

- [ ] **Step 6: Commit**

```bash
git add dev-implement/SKILL.md
git commit -m "feat(dev-implement): model:sonnet + impl-plan.md読み込み + feedback対応を追加"
```

---

## Task 8: dev-kickoff の SKILL.md を更新

**Files:**
- Modify: `dev-kickoff/SKILL.md`

- [ ] **Step 1: Phase テーブルを 8 Phase に更新**

```markdown
| Phase | Action | Complete When | Single Mode | Parallel Mode (--task-id) |
|-------|--------|---------------|-------------|---------------------------|
| 1 | Worktree creation | Path exists, .env verified | **REQUIRED** | SKIP |
| 2 | Issue analysis | Requirements understood | **REQUIRED** | SKIP |
| 3 | Implementation plan | impl-plan.md created | Execute | Execute |
| 4 | Implementation | Code written | Execute | Execute |
| 5 | Validation | Tests pass | Execute | Execute |
| 6 | Evaluation | Quality gate passed | Execute | Execute |
| 7 | Commit | Changes committed | Execute | Execute |
| 8 | PR creation | PR URL available | Execute | SKIP |
```

- [ ] **Step 2: Phase Checklist を更新**

```markdown
## Phase Checklist

[ ] Phase 1: git-prepare.sh → init-kickoff.sh          (REQUIRED unless --task-id)
[ ] Phase 2: Skill: dev-issue-analyze                   (REQUIRED unless --task-id)
[ ] Phase 3: Skill: dev-plan-impl                       (NEW - Opus planner)
[ ] Phase 4: Skill: dev-implement                       (Sonnet)
[ ] Phase 5: Skill: dev-validate --fix
[ ] Phase 6: Skill: dev-evaluate                        (NEW - Opus evaluator, context:fork)
  → fail + design feedback → Phase 3
  → fail + implementation feedback → Phase 4
  → pass or max iterations → Phase 7
[ ] Phase 7: Skill: git-commit --all
[ ] Phase 8: Skill: git-pr → pr-iterate                 (REQUIRED unless --task-id)
```

- [ ] **Step 3: Phase Execution テーブルを更新**

```markdown
| Phase | Command | Subagent | Parallel Mode |
|-------|---------|----------|---------------|
| 1 | git-prepare.sh ... | - | SKIP |
| 1b | init-kickoff.sh ... | - | SKIP |
| 2 | Skill: dev-issue-analyze | Task(Explore) | SKIP |
| 3 | Skill: dev-plan-impl $ISSUE --worktree $PATH | - | Execute |
| 4 | Skill: dev-implement --testing $TESTING --worktree $PATH | - | Execute |
| 5 | Skill: dev-validate --fix --worktree $PATH | Task(quality-engineer) | Execute |
| 6 | Skill: dev-evaluate $ISSUE --worktree $PATH | context:fork | Execute |
| 7 | Skill: git-commit --all --worktree $PATH | - | Execute |
| 8 | Skill: git-pr ... | - | SKIP |
```

- [ ] **Step 4: リトライループセクションを追加**

Phase Execution の後に追加:

```markdown
## Evaluate-Retry Loop

After Phase 6 (dev-evaluate) completes:

1. Parse the evaluation JSON result
2. Write result to kickoff.json: `update-phase.sh 6_evaluate done --eval-result '$JSON' --worktree $PATH`
3. If `verdict == "pass"` → proceed to Phase 7
4. If `verdict == "fail"` AND current_iteration < max_iterations:
   - Read `feedback_level` from result
   - If `"design"` → reset to Phase 3: `update-phase.sh 6_evaluate done --reset-to 3_plan_impl --worktree $PATH`
   - If `"implementation"` → reset to Phase 4: `update-phase.sh 6_evaluate done --reset-to 4_implement --worktree $PATH`
   - Pass feedback to the target phase
5. If max_iterations reached → proceed to Phase 7 with warning
6. If evaluate fork fails → retry once, then skip with warning (see spec for details)
```

- [ ] **Step 5: CRITICAL notice を更新**

ファイル冒頭の `## CRITICAL: Complete All 6 Phases` を以下に変更:

```markdown
## CRITICAL: Complete All 8 Phases

**DO NOT EXIT until Phase 8 (PR creation) completes and pr-iterate is called.**
```

- [ ] **Step 6: State Management セクションの update-phase コマンド例を更新**

Phase 番号を新しい番号体系に合わせる（`5_commit` → `7_commit`, `6_pr` → `8_pr` 等）。

- [ ] **Step 7: 検証 — Phase 番号の一貫性確認**

```bash
grep -n "Phase [0-9]" dev-kickoff/SKILL.md | head -20
```

旧 Phase 番号（Phase 5: commit, Phase 6: PR）が残っていないことを確認。

- [ ] **Step 8: Commit**

```bash
git add dev-kickoff/SKILL.md
git commit -m "feat(dev-kickoff): SKILL.md を 8 Phase + リトライループに更新"
```

---

## Task 9: skill-config.json に新スキル設定を追加

**Files:**
- Modify: `skill-config.json`

- [ ] **Step 1: dev-evaluate, dev-plan-impl, dev-implement の設定を追加**

```json
{
  "dev-evaluate": {
    "model": "opus",
    "threshold": 7.0,
    "max_iterations": 5
  },
  "dev-plan-impl": {
    "model": "opus"
  },
  "dev-implement": {
    "model": "sonnet"
  }
}
```

既存のキーの後に追加。

- [ ] **Step 2: 検証 — JSON 構文チェック**

Run: `jq . skill-config.json > /dev/null`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add skill-config.json
git commit -m "feat(config): dev-evaluate/dev-plan-impl/dev-implement設定を追加"
```

---

## Task 10: 統合検証

- [ ] **Step 1: 全スクリプトの構文チェック**

```bash
bash -n dev-kickoff/scripts/init-kickoff.sh && \
bash -n dev-kickoff/scripts/update-phase.sh && \
bash -n dev-kickoff/scripts/next-action.sh && \
bash -n dev-evaluate/scripts/detect-task-type.sh && \
echo "All scripts OK"
```

- [ ] **Step 2: init → update → next-action の統合テスト**

```bash
mkdir -p /tmp/test-integration-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-integration-wt --base main && \
bash dev-kickoff/scripts/update-phase.sh 2_analyze done --result "Done" --worktree /tmp/test-integration-wt && \
bash dev-kickoff/scripts/update-phase.sh 3_plan_impl in_progress --worktree /tmp/test-integration-wt && \
bash dev-kickoff/scripts/update-phase.sh 3_plan_impl done --result "Plan created" --worktree /tmp/test-integration-wt && \
bash dev-kickoff/scripts/next-action.sh --worktree /tmp/test-integration-wt | jq '.next_phase' && \
rm -rf /tmp/test-integration-wt
```

Expected: `"4_implement"`

- [ ] **Step 3: evaluate iterations 書き込みテスト**

```bash
mkdir -p /tmp/test-eval-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-eval-wt --base main && \
bash dev-kickoff/scripts/update-phase.sh 6_evaluate in_progress --worktree /tmp/test-eval-wt && \
bash dev-kickoff/scripts/update-phase.sh 6_evaluate done \
  --eval-result '{"iteration":1,"verdict":"fail","total":5.8,"feedback_level":"implementation","feedback":["Missing error handling"],"timestamp":"2026-03-28T10:00:00Z"}' \
  --worktree /tmp/test-eval-wt && \
jq '.phases["6_evaluate"].iterations | length' /tmp/test-eval-wt/.claude/kickoff.json && \
jq '.phases["6_evaluate"].current_iteration' /tmp/test-eval-wt/.claude/kickoff.json && \
rm -rf /tmp/test-eval-wt
```

Expected:
```
1
1
```

- [ ] **Step 4: reset-to + 再 iterate テスト**

```bash
mkdir -p /tmp/test-retry-wt/.claude && \
bash dev-kickoff/scripts/init-kickoff.sh 42 feature/test /tmp/test-retry-wt --base main && \
# Simulate full loop
for phase in 2_analyze 3_plan_impl 4_implement 5_validate; do
  bash dev-kickoff/scripts/update-phase.sh $phase done --result "Done" --worktree /tmp/test-retry-wt
done && \
bash dev-kickoff/scripts/update-phase.sh 6_evaluate done \
  --eval-result '{"iteration":1,"verdict":"fail","total":5.0,"feedback_level":"design","feedback":["Bad arch"],"timestamp":"2026-03-28T10:00:00Z"}' \
  --reset-to 3_plan_impl --worktree /tmp/test-retry-wt && \
echo "After reset:" && \
jq '{current: .current_phase, plan: .phases["3_plan_impl"].status, impl: .phases["4_implement"].status}' /tmp/test-retry-wt/.claude/kickoff.json && \
rm -rf /tmp/test-retry-wt
```

Expected:
```json
{"current": "3_plan_impl", "plan": "pending", "impl": "pending"}
```

- [ ] **Step 5: JSON スキーマ全体の整合性確認**

```bash
jq . _lib/schemas/kickoff.schema.json > /dev/null && \
jq . skill-config.json > /dev/null && \
echo "All JSON valid"
```

- [ ] **Step 6: SKILL.md frontmatter 構文確認**

```bash
head -20 dev-evaluate/SKILL.md && echo "---" && head -15 dev-plan-impl/SKILL.md
```

目視で YAML frontmatter が正しいことを確認。

- [ ] **Step 7: 最終 Commit（統合テスト用の修正があれば）**

テストで問題が見つかった場合のみ。問題なければスキップ。
