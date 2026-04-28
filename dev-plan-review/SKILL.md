---
name: dev-plan-review
description: |
  Critically review implementation plan as independent agent (devil's advocate).
  Use when: (1) plan quality gate before implementation, (2) dev-kickoff Phase 3b,
  (3) standalone review of any impl-plan.md,
  (4) keywords: plan review, 計画レビュー, devil's advocate, 批判的レビュー
  Accepts args: [<issue-number>] [--worktree <path>] [--plan <path>] [--pass-threshold 80]
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
effort: max
context: fork
---

# Plan Review

Independent critical review of implementation plans. Runs in a separate context (context:fork) to eliminate confirmation bias from the Planner (dev-plan-impl).

## Usage

### dev-kickoff 経由 (Phase 3b)

```
/dev-plan-review <issue-number> --worktree <path>
```

### スタンドアロン

```
/dev-plan-review --plan path/to/impl-plan.md
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | - | GitHub issue number (worktree mode) |
| `--worktree` | - | Worktree path (reads kickoff.json + impl-plan.md) |
| `--plan` | - | Direct path to plan file (standalone mode) |
| `--pass-threshold` | `80` | Verdict pass threshold (0–100 integer score) |

> **Note**: ループ回数 (`max_iterations`) は orchestrator である `dev-kickoff` 側で制御します（`config.plan_review.max_iterations`、既定 3）。本 skill は単一 review を実行するだけで、ループ管理は行いません。旧 `--max-rounds` 引数は削除されました。

## Workflow

```
1. Collect inputs → 2. Review against checklist → 3. Classify findings → 4. Score & verdict → 5. Output JSON
```

## Output Contract (JSON Schema)

本 skill は stdout に**必ず**以下の JSON を出力する（dev-kickoff Phase 3b ループはこの schema を前提にループ制御する）。

```jsonc
{
  "score": 85,                       // 0–100 の整数（plan 全体の品質スコア）
  "verdict": "pass",                 // "pass" | "revise" | "block"
  "pass_threshold": 80,              // 本 review で使用した閾値（既定 80）
  "findings": [
    {
      "severity": "major",           // "critical" | "major" | "minor"
      "dimension": "architecture",   // checklist の次元名
      "topic": "Missing rollback strategy",   // 1 行の short title（stuck 判定キー）
      "description": "What's wrong and why it matters",
      "suggestion": "Concrete fix to apply in next revision"
    }
  ],
  "summary": "Plan is mostly solid; 1 major finding blocks pass."
}
```

### Severity 定義

- **critical**: 実装方針が根本的に誤っており、継続すると大きな手戻りが発生する
- **major**: pass には届かない（revise 必須）レベルの設計/範囲/整合性の問題
- **minor**: 非ブロッキング。次回 revise で直せれば望ましいが無視しても進行可

### Verdict 判定ルール

1. critical が 1 件でもある、または `score < 60` → **`block`**
2. major が 1 件でもある、または `60 <= score < pass_threshold` → **`revise`**
3. それ以外（critical/major なし かつ `score >= pass_threshold`） → **`pass`**

### Scoring ガイドライン

`score` は plan の全体品質を 0–100 の整数で採点する目安:

- 90–100: 本質的な指摘なし。minor のみ
- 80–89: minor 中心、軽微な曖昧さあり（`pass_threshold` 既定）
- 60–79: major を含み revise 必要
- 40–59: critical 1 件または major 複数
- 0–39: 方針レベルで破綻、block

### 後方互換

旧 schema の `verdict: "fail"` / `severity: "blocking" | "non-blocking"` を参照していた呼び出し元が残っている場合は、次のように読み替える:

- `verdict: "fail"` → `revise` または `block`（critical の有無で区別）
- `severity: "blocking"` → `critical` または `major`
- `severity: "non-blocking"` → `minor`

dev-kickoff は本 SKILL.md 更新に合わせて新 verdict のみ評価する。

## Step 1: Collect Inputs

**Worktree mode** (from dev-kickoff):
1. **Issue requirements**: Read `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`
2. **Implementation plan**: Read `$WORKTREE/.claude/impl-plan.md`
3. **Config**: Read `$WORKTREE/.claude/kickoff.json` → `config`

**Standalone mode** (direct invocation):
1. Read the plan file specified by `--plan`
2. If the plan references an issue, try to read issue context from git or GitHub

If impl-plan.md does not exist (worktree mode) or plan file does not exist (standalone mode), output error JSON and exit.

## Step 2: Review Against Checklist

Apply [Review Checklist](references/review-checklist.md) systematically.

For each dimension, evaluate whether the plan adequately addresses the concern. Be specific — cite the exact section of the plan that is problematic or missing.

## Step 3: Classify Findings

各 finding を **critical / major / minor** の 3 レベルで分類する。

- **critical**: 方針が根本的に誤っている。見逃すと大規模な手戻り。
  - 典型: テスト不能な受け入れ条件／根拠なき重要なアーキテクチャ決定で実装方向が間違う／必須ファイルの欠落で conflict 必至／依存関係の矛盾／セキュリティ脆弱性の無視
- **major**: pass まで届かない品質ギャップ。revise で潰す必要あり。
  - 典型: edge case の扱い未定／小～中規模の整合性欠如／テスト戦略の曖昧／変更ファイル list の取り違え
- **minor**: 進行可能な改善提案。pass を妨げない。
  - 典型: 命名／コメント／微細な YAGNI／将来の拡張メモ

各 finding は必ず以下を含める:
- `severity`: 上の 3 レベル
- `dimension`: チェックリストの次元名（scope / architecture / file_changes / edge_cases / dependencies / security / implementation_order / testing など）
- `topic`: 1 行の短い識別子（**stuck 検出の fingerprinting キーになるため、毎回同じ問題は同じ文字列で書くこと**）
- `description`: 何が問題でなぜ重要か
- `suggestion`: 次の revision で取るべき具体的な修正

## Step 4: Score and Determine Verdict

1. **Score**: plan 全体の品質を `0–100` の整数で採点（上記 Scoring ガイドライン参照）
2. **Verdict 判定**:
   - critical が 1 件以上、または `score < 60` → **`block`**
   - 上に該当しない & major が 1 件以上、または `60 <= score < pass_threshold` → **`revise`**
   - critical/major がなく、`score >= pass_threshold` → **`pass`**
3. 既定 `pass_threshold = 80`。caller が明示的に指定した場合はそれに従う。

各 finding には「何が問題か」「なぜ重要か」「どう直すか」を具体的に書くこと。"Architecture is weak" 等の抽象は禁止。

## Step 5: Output JSON

Print the review result as JSON to stdout. この JSON は dev-kickoff の Plan-Review Loop が読み取って verdict / findings / score を判定する正式 I/F である。

### Pass 例:

```json
{
  "score": 88,
  "verdict": "pass",
  "pass_threshold": 80,
  "findings": [
    {
      "severity": "minor",
      "dimension": "scope",
      "topic": "Docs polish",
      "description": "Wording on README could be tightened",
      "suggestion": "Optional cleanup in follow-up PR"
    }
  ],
  "summary": "Plan is solid. Only minor cosmetic suggestions."
}
```

### Revise 例:

```json
{
  "score": 72,
  "verdict": "revise",
  "pass_threshold": 80,
  "findings": [
    {
      "severity": "major",
      "dimension": "edge_cases",
      "topic": "Empty-input handling unspecified",
      "description": "Edge case is listed but no handling strategy is given; implementation will guess.",
      "suggestion": "Specify that empty input returns early with a no-op and add a unit test."
    },
    {
      "severity": "minor",
      "dimension": "testing",
      "topic": "Integration test missing",
      "description": "Plan only covers unit tests.",
      "suggestion": "Add one end-to-end smoke test path."
    }
  ],
  "summary": "1 major gap in edge case handling needs revision."
}
```

### Block 例:

```json
{
  "score": 48,
  "verdict": "block",
  "pass_threshold": 80,
  "findings": [
    {
      "severity": "critical",
      "dimension": "architecture",
      "topic": "Wrong ownership boundary",
      "description": "Loop control is placed in dev-plan-impl, but that skill is invoked inside the loop — infinite recursion risk.",
      "suggestion": "Move loop responsibility to dev-kickoff (orchestrator). Revise architecture decision."
    }
  ],
  "summary": "Critical design issue — plan must be reworked before implementation."
}
```

## Important

- **No access to planning context**: You only see the plan and requirements. This is by design.
- **Be specific in feedback**: "Architecture is weak" is useless. Point to specific decisions, missing files, or gaps.
- **Review honestly**: The purpose is to catch plan-level issues before wasting implementation effort, not to rubber-stamp.
- **Respect scope**: Don't demand features beyond the issue requirements. YAGNI applies to review too.
- **Standalone is lightweight**: In standalone mode without issue context, focus on internal consistency and completeness of the plan itself.

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On pass or fail verdict (review completed successfully)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-review success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On review process error (missing inputs, script crash, etc.)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-review failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

Note: A "fail" verdict is a successful review — the reviewer did its job. Only log as failure when the review process itself errors.

## References

- [Review Checklist](references/review-checklist.md) - Review dimensions and criteria
