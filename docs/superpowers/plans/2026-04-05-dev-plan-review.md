# dev-plan-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実装計画(impl-plan.md)を批判的にレビューする独立スキル dev-plan-review を作成し、dev-kickoff の Phase 3→4 間に組み込む

**Architecture:** dev-evaluate と対称的な構造。`context: fork` + `model: opus` で計画作成者とは独立したコンテキストからレビュー。github-issue-orchestrator の devil's advocate パターンを計画レビュー用に適応。verdict JSON で pass/fail を返し、fail 時は dev-plan-impl へフィードバックループ。

**Tech Stack:** Bash (scripts), Markdown (SKILL.md, references)

---

## File Structure

```
dev-plan-review/              # 新規スキル
├── SKILL.md                  # Frontmatter + ワークフロー
└── references/
    └── review-checklist.md   # レビュー観点チェックリスト

dev-kickoff/
├── SKILL.md                  # Phase 3.5 追加
├── scripts/
│   ├── init-kickoff.sh       # 3b_plan_review phase 追加
│   └── update-phase.sh       # 3b_plan_review を VALID_PHASES・遷移に追加
└── references/
    ├── state-management.md   # state schema に 3b_plan_review 追加
    ├── evaluate-retry.md     # plan-review retry ロジック追記
    └── phase-detail.md       # Phase 3b ドキュメント追加
```

---

### Task 1: dev-plan-review/SKILL.md 作成

**Files:**
- Create: `dev-plan-review/SKILL.md`

- [ ] **Step 1: SKILL.md を作成**

dev-evaluate と対称的な構造で、以下の frontmatter + ワークフローを書く:

```markdown
---
name: dev-plan-review
description: |
  Critically review implementation plan as independent agent (devil's advocate).
  Use when: (1) plan quality gate before implementation, (2) dev-kickoff Phase 3b,
  (3) standalone review of any impl-plan.md,
  (4) keywords: plan review, 計画レビュー, devil's advocate, 批判的レビュー
  Accepts args: [<issue-number>] [--worktree <path>] [--plan <path>] [--max-rounds 3]
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
context: fork
agent: general-purpose
---

# Plan Review

Independent critical review of implementation plans. Runs in a separate context (context:fork) to eliminate confirmation bias from the Planner (dev-plan-impl).

## Usage

### dev-kickoff 経由 (Phase 3b)
/dev-plan-review <issue-number> --worktree <path>

### スタンドアロン
/dev-plan-review --plan path/to/impl-plan.md

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | - | GitHub issue number (worktree mode) |
| `--worktree` | - | Worktree path (reads kickoff.json + impl-plan.md) |
| `--plan` | - | Direct path to plan file (standalone mode) |
| `--max-rounds` | `3` | Max review-revision rounds |

## Workflow

1. Collect inputs → 2. Review against checklist → 3. Classify findings → 4. Verdict → 5. Output JSON

## Step 1: Collect Inputs

**Worktree mode** (from dev-kickoff):
1. Issue requirements: Read `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`
2. Implementation plan: Read `$WORKTREE/.claude/impl-plan.md`
3. Config: Read `$WORKTREE/.claude/kickoff.json` → `config`

**Standalone mode** (direct invocation):
1. Read the plan file specified by `--plan`
2. If the plan references an issue, try to read issue context from git or GitHub

If impl-plan.md does not exist, output error JSON and exit.

## Step 2: Review Against Checklist

Apply [Review Checklist](references/review-checklist.md) systematically.

For each dimension, evaluate whether the plan adequately addresses the concern. Be specific — cite the exact section of the plan that is problematic or missing.

## Step 3: Classify Findings

For each finding:
- **blocking**: Must be fixed before implementation. The plan has a gap that will cause rework.
- **non-blocking**: Worth noting but implementation can proceed. Minor improvements.

A finding is blocking if ANY of:
- Missing or untestable acceptance criteria
- Architecture decision without rationale that could lead to wrong direction
- File changes that will conflict or are missing critical files
- Edge cases listed without handling strategy
- Dependencies not accounted for
- Security implications ignored

## Step 4: Determine Verdict

- No blocking findings → verdict: **pass**
- Blocking findings exist → verdict: **fail**
  - Include specific, actionable feedback for each blocking finding
  - Each feedback item should describe: what's wrong, why it matters, suggested fix

## Step 5: Output JSON

Print the review result as JSON to stdout.

### Pass:
{
  "verdict": "pass",
  "findings": [
    {"dimension": "scope", "severity": "non-blocking", "description": "..."}
  ],
  "summary": "Plan is solid. Minor suggestions noted."
}

### Fail:
{
  "verdict": "fail",
  "findings": [
    {"dimension": "architecture", "severity": "blocking", "description": "...", "suggestion": "..."},
    {"dimension": "edge_cases", "severity": "non-blocking", "description": "..."}
  ],
  "summary": "2 blocking issues found. Plan needs revision before implementation."
}

## Important

- **No access to planning context**: You only see the plan and requirements. This is by design.
- **Be specific in feedback**: "Architecture is weak" is useless. Point to specific decisions, missing files, or gaps.
- **Review honestly**: The purpose is to catch plan-level issues before wasting implementation effort, not to rubber-stamp.
- **Respect scope**: Don't demand features beyond the issue requirements. YAGNI applies to review too.
- **Standalone is lightweight**: In standalone mode without issue context, focus on internal consistency and completeness of the plan itself.

## Journal Logging

On completion, log execution to skill-retrospective journal:

$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-review success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-review failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE

Note: A "fail" verdict is a successful review — the reviewer did its job. Only log as failure when the review process itself errors.

## References

- [Review Checklist](references/review-checklist.md) - Review dimensions and criteria
```

- [ ] **Step 2: 作成内容を確認**

Read `dev-plan-review/SKILL.md` を実行し、frontmatter のパース・構造を目視確認。

---

### Task 2: dev-plan-review/references/review-checklist.md 作成

**Files:**
- Create: `dev-plan-review/references/review-checklist.md`

- [ ] **Step 1: review-checklist.md を作成**

github-issue-orchestrator の devils-advocate-checklist.md を参考に、**実装計画レビュー**に特化したチェックリストを書く:

```markdown
# Plan Review Checklist

Implementation plan を批判的にレビューするためのチェックリスト。

## Review Dimensions

### 1. Scope & Requirements Alignment
- 計画が issue の受入基準を全てカバーしているか？
- issue に書かれていない機能を勝手に追加していないか？（YAGNI）
- 計画の Overview が issue の目的と一致しているか？

### 2. File Changes Completeness
- 変更が必要なファイルが全て File Changes に列挙されているか？
- テストファイルが含まれているか？（testing config が tdd/bdd の場合）
- 設定ファイルやマイグレーションファイルの変更漏れはないか？
- 既存ファイルの modify で影響範囲が正しく特定されているか？

### 3. Architecture Decisions
- 各設計判断に「なぜ」が書かれているか？
- 代替案が検討された形跡があるか？（少なくとも重要な判断について）
- 既存コードベースのパターンと一貫しているか？
- 責務の分離は適切か？

### 4. Edge Cases & Error Handling
- Edge Cases セクションに対応方針が書かれているか？（ケース列挙だけでは不十分）
- 異常系（null, 空, 境界値, 認証失敗等）が考慮されているか？
- エラー時のユーザー/システム挙動が明確か？

### 5. Dependencies & Integration
- 外部ライブラリの追加は妥当か？既存の依存で代替できないか？
- 内部モジュール間の依存関係は明確か？
- 破壊的変更がある場合、マイグレーション計画があるか？

### 6. Implementability
- 計画が十分に具体的か？（「適切に実装」等の曖昧な指示がないか）
- Generator (Sonnet) が迷わず実装できる粒度か？
- ファイルパスは具体的か？
- 実装順序に依存関係の矛盾がないか？

### 7. Security & Data Safety
- ユーザー入力のバリデーションが考慮されているか？
- 認証/認可への影響が検討されているか？
- 機密データの扱いが適切か？

## Blocking Criteria

以下のいずれかに該当する finding は blocking:
- 受入基準の欠落（issue 要件が計画に反映されていない）
- File Changes に明らかな漏れがある
- Architecture Decision に理由がなく、誤った方向に進むリスクがある
- Edge Case に対応方針がない（列挙のみ）
- 依存関係の矛盾（実装不可能な順序）
- セキュリティ上の懸念が無視されている

## Review Protocol

1. 各 dimension について計画を評価
2. finding を blocking / non-blocking に分類
3. blocking finding には具体的な修正提案を付ける
4. blocking が 0 になるまで修正ループ（max-rounds まで）
```

---

### Task 3: dev-kickoff/scripts/init-kickoff.sh に 3b_plan_review phase を追加

**Files:**
- Modify: `dev-kickoff/scripts/init-kickoff.sh:116-122`

- [ ] **Step 1: phases オブジェクトに 3b_plan_review を追加**

init-kickoff.sh の jq テンプレート内、`3_plan_impl` と `4_implement` の間に追加:

```diff
             "3_plan_impl": { status: "pending" },
+            "3b_plan_review": { status: "pending" },
             "4_implement": { status: "pending" },
```

- [ ] **Step 2: 動作確認**

Run: `bash -n dev-kickoff/scripts/init-kickoff.sh`
Expected: シンタックスエラーなし

---

### Task 4: dev-kickoff/scripts/update-phase.sh に 3b_plan_review を追加

**Files:**
- Modify: `dev-kickoff/scripts/update-phase.sh:24` (VALID_PHASES)
- Modify: `dev-kickoff/scripts/update-phase.sh:99-103` (phase transitions)
- Modify: `dev-kickoff/scripts/update-phase.sh:165` (PHASE_ORDER for reset)

- [ ] **Step 1: VALID_PHASES に追加**

```diff
-VALID_PHASES="1_prepare 2_analyze 3_plan_impl 4_implement 5_validate 6_evaluate 7_commit 8_pr"
+VALID_PHASES="1_prepare 2_analyze 3_plan_impl 3b_plan_review 4_implement 5_validate 6_evaluate 7_commit 8_pr"
```

- [ ] **Step 2: phase transition (done ケース) に追加**

```diff
             3_plan_impl) JQ_ARGS+=(--arg next "3b_plan_review"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
+            3b_plan_review) JQ_ARGS+=(--arg next "4_implement"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
```

Note: 既存の `3_plan_impl` の next を `4_implement` → `3b_plan_review` に変更。

- [ ] **Step 3: PHASE_ORDER (reset 用) に追加**

```diff
-    PHASE_ORDER=("3_plan_impl" "4_implement" "5_validate" "6_evaluate")
+    PHASE_ORDER=("3_plan_impl" "3b_plan_review" "4_implement" "5_validate" "6_evaluate")
```

- [ ] **Step 4: 動作確認**

Run: `bash -n dev-kickoff/scripts/update-phase.sh`
Expected: シンタックスエラーなし

---

### Task 5: dev-kickoff/SKILL.md に Phase 3b を追加

**Files:**
- Modify: `dev-kickoff/SKILL.md`

- [ ] **Step 1: Phase Checklist テーブルに Phase 3b を追加**

Phase 3 と Phase 4 の間に挿入:

```diff
 | 3 | Implementation plan | impl-plan.md created | Execute | Execute |
+| 3b | Plan review | Plan approved or revised | Execute | Execute |
 | 4 | Implementation | Code written | Execute | Execute |
```

- [ ] **Step 2: Phase Checklist (チェックボックス) に追加**

```diff
 [ ] Phase 3: Skill: dev-plan-impl                       (NEW - Opus planner)
+[ ] Phase 3b: Skill: dev-plan-review                    (NEW - Opus reviewer, context:fork)
+  → fail → back to Phase 3 (with feedback)
+  → pass or max rounds (3) → Phase 4
 [ ] Phase 4: Skill: dev-implement                       (Sonnet generator)
```

- [ ] **Step 3: Phase Execution テーブルに追加**

```diff
 | 3 | `Skill: dev-plan-impl $ISSUE --worktree $PATH` | - | Execute |
+| 3b | `Skill: dev-plan-review $ISSUE --worktree $PATH` | context:fork | Execute |
 | 4 | `Skill: dev-implement --testing $TESTING [--design $DESIGN] --worktree $PATH` | - | Execute |
```

- [ ] **Step 4: Evaluate-Retry Loop セクションに plan-review のフローを追記**

Phase 3b verdict の処理を追加:

```markdown
## Plan-Review Loop

Phase 3b verdict determines next step: `pass` → Phase 4, `fail` → retry from Phase 3 (dev-plan-impl with feedback). Max 3 rounds. Fork failure → retry once, then skip with warning.
```

---

### Task 6: dev-kickoff/references を更新

**Files:**
- Modify: `dev-kickoff/references/state-management.md`
- Modify: `dev-kickoff/references/evaluate-retry.md`
- Modify: `dev-kickoff/references/phase-detail.md`

- [ ] **Step 1: state-management.md の state schema に 3b_plan_review を追加**

kickoff.json の phases セクションに追加:

```diff
             "3_plan_impl": { status: "pending" },
+            "3b_plan_review": { status: "pending", iterations: [], current_iteration: 0, max_rounds: 3 },
             "4_implement": { status: "pending" },
```

- [ ] **Step 2: evaluate-retry.md に Plan-Review Loop セクションを追加**

ファイル末尾に追記:

```markdown
## Plan-Review Loop (Phase 3b)

After Phase 3b (dev-plan-review) returns review JSON:

### Flow

1. **Record result**: `update-phase.sh 3b_plan_review done --worktree $PATH`
2. **If `verdict == "pass"`**: Proceed to Phase 4 (dev-implement)
3. **If `verdict == "fail"` AND rounds < max_rounds (default 3)**:
   - Write review feedback to `$WORKTREE/.claude/plan-review-feedback.json`
   - Reset to Phase 3:
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done --reset-to 3_plan_impl --worktree $PATH
     ```
   - dev-plan-impl reads feedback and revises the plan
4. **If max_rounds reached**: Proceed to Phase 4 with warning log
5. **If review fork fails**: Retry once. If still fails, skip and proceed to Phase 4 with warning.
```

- [ ] **Step 3: phase-detail.md に Phase 3b セクションを追加**

Phase 3 (Implementation Plan) と Phase 4 (Implementation) の間に:

```markdown
## Phase 3b: Plan Review

**Command:**
Skill: dev-plan-review $ISSUE --worktree $PATH

**Subagent:** context:fork (Opus, general-purpose) - independent review context

**Purpose:** 実装計画を批判的にレビューし、実装前に問題を発見する。

**Input:**
- `$WORKTREE/.claude/impl-plan.md` (from Phase 3)
- `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`

**Completion Criteria:**
- verdict: pass (blocking findings なし)
- または max_rounds (3) に到達

**On Fail:**
1. Review feedback を `$WORKTREE/.claude/plan-review-feedback.json` に保存
2. Phase 3 (dev-plan-impl) に戻り、feedback を反映した計画を再作成

**State Update:**
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done \
  --result "Plan approved" \
  --worktree $PATH
```

- [ ] **Step 4: phase-detail.md の Phase Overview 図を更新**

```diff
 Phase 3: Implementation Plan (dev-plan-impl)
     ↓
+Phase 3b: Plan Review (dev-plan-review) ←→ Phase 3 (retry on fail)
+    ↓
 Phase 4: Implementation (dev-implement)
```

---

### Task 7: dev-plan-impl に plan-review feedback 読み込みを追加

**Files:**
- Modify: `dev-plan-impl/SKILL.md`

- [ ] **Step 1: Step 2 に plan-review feedback の読み込みを追加**

既存の Step 2 (Check for Evaluator Feedback) に plan-review feedback も読む処理を追記:

```markdown
## Step 2: Check for Feedback (Retry)

### Evaluator Feedback (Phase 6)
If `$WORKTREE/.claude/kickoff.json` → `phases.6_evaluate.iterations[]` has entries:
- Read the latest iteration's `feedback` array
- (existing content...)

### Plan Review Feedback (Phase 3b)
If `$WORKTREE/.claude/plan-review-feedback.json` exists:
- Read the review findings with severity `blocking`
- Address each blocking finding in the revised plan
- Note how each finding was addressed in the Architecture Decisions or relevant section
```

---

### Task 8: コミット

- [ ] **Step 1: 全ファイルの変更を確認**

Run: `git diff --stat` and `git status`

- [ ] **Step 2: コミット**

```bash
git add dev-plan-review/
git add dev-kickoff/SKILL.md dev-kickoff/scripts/ dev-kickoff/references/
git add dev-plan-impl/SKILL.md
git commit -m "feat(dev-plan-review): 計画の批判的レビュースキルを追加し dev-kickoff Phase 3b に組み込み"
```
