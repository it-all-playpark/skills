---
name: dev-implement
description: |
  Feature implementation with strategy selection and optional worktree isolation.
  Use when: implementing features, fixing bugs, refactoring code, building components.
  Accepts args: [feature] [--testing tdd|bdd] [--design ddd] [--type component|api|service]
    [--framework react|vue|express] [--worktree <path>] [--with-tests] [--safe]
model: sonnet
---

# Implement

Execute feature implementation with configurable strategy and context.

## Usage

```
/implement [feature] [options]
```

| Arg | Description |
|-----|-------------|
| feature | What to implement |
| --testing | Implementation approach: tdd (test-first, default), bdd (behavior-first) |
| --design | Design approach: ddd (domain modeling before implementation) |
| --type | component, api, service, feature |
| --framework | react, vue, express, etc. |
| --worktree | Path to worktree (for isolated development) |
| --with-tests | Include test generation |
| --safe | Extra validation gates |

## Strategy

Testing axis (`--testing`): tdd (default) or bdd. Design axis (`--design`): ddd (opt-in).
These are independent and composable (e.g. `--testing tdd --design ddd`).

Details: [Strategy Model](references/strategy-model.md)

## Workflow

```
1. Context & Stack Detection → 2. Design (if --design) → 3. Plan → 4. Implement → 5. Validate → 6. Review
```

### Step 1: Context & Stack Detection

Detect from codebase or args: framework/tech stack, existing patterns, project conventions.

**Best practice loading**:
If invoked from dev-kickoff workflow (dev-issue-analyze already loaded best practices
into context), skip detect-stack.sh -- the context already contains framework guidelines.

If invoked standalone (no prior dev-issue-analyze):
1. Run `$SKILLS_DIR/_lib/scripts/detect-stack.sh` to detect frameworks
2. For each detected skill in `rules_paths`, Read the corresponding SKILL.md

If `--worktree` provided, all operations within that path.

### Step 2: Design Phase (if --design ddd)

Execute domain modeling BEFORE implementation: identify entities/value objects, define aggregates/boundaries, map relationships, design domain-to-infrastructure mapping.

Details: [Strategy Model - DDD](references/strategy-model.md#design-strategy-details)

### Step 3: Plan Implementation

**Task source-of-truth (preferred)**: 親 orchestrator（dev-kickoff / dev-kickoff-worker）が prompt 内に
`task_body` を paste している場合、その本文を真実の source とする。**この場合は
`impl-plan.md` を `Read` しない**（context 浪費と曖昧参照誤読を避けるため。詳細は
[`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md) の "Paste, Don't Link" 規約参照）。
`task_body` 内に `## Test Plan` セクションが含まれる場合は Step 4 でそれを優先使用する。

**Paste delimiter 仕様**: parent orchestrator が `<<<TASK_BODY_BEGIN>>>` / `<<<TASK_BODY_END>>>` の
delimiter で paste した場合、その区間内テキストを task body として消費する（推奨フォーマット）。
delimiter が含まれていない paste の場合は orchestrator 側のバグまたは古い orchestrator の可能性が
あるため、prompt 内に `## task_body` 等の明示的 section header を探して fallback で読み取る。
それも見つからない場合は `NEEDS_CONTEXT` を返し、`missing_context` に
`"task_body delimiter or section header not found in prompt"` を入れる（impl-plan.md への暗黙
fallback はしない）。delimiter 仕様: [`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md#推奨-paste-フォーマット)。

**impl-plan.md fallback (standalone)**: `task_body` 入力が無く、かつ `$WORKTREE/.claude/impl-plan.md` が
存在する場合のみ (= standalone 実行 / 旧 orchestrator)、その plan を follow する。
Do not re-plan from scratch. If the plan has a "Notes for Retry" section, address the feedback noted there.

**Evaluator Feedback (retry mode)**: On retry, read `kickoff.json` → `phases.6_evaluate.iterations[]`
for the latest feedback. The `feedback` array contains specific issues to address.
The `feedback_level` indicates whether the issues are design-level (re-plan needed)
or implementation-level (re-implement within existing plan).

If neither `task_body` nor `impl-plan.md` is available (true standalone invocation), plan as before.
Check installed skills for tasks that match -- prefer Skill invocation over manual implementation.

Details: [Skill-Aware Planning](references/skill-aware-planning.md)

Based on `--testing` (default: tdd): tdd = Write tests first → Implement → Refactor. bdd = Define behavior specs → Implement → Verify.

Create TodoWrite items for tracking (>3 steps).

### Step 4: Implement (Red → Green → Refactor)

`task_body` または `impl-plan.md` (fallback) に `## Test Plan` がある場合、**必ず以下 3 sub-phase を順に実行**する。確認ダイアログは挟まず、各 sub-phase の成否は自動検証（`dev-validate`）で判定する。`task_body` が paste されている場合はそちらを優先し、`impl-plan.md` の全体 Read は行わない。

#### Step 4a: Red — Write Failing Tests First

1. `## Test Plan` のテストエントリを全て**テストファイルにのみ**書く（実装コードは書かない）
2. `dev-validate` を実行し、「テストが期待通り FAIL している」ことを検証
3. **Red 不成立時の自動リトライ条件**:
   - `Expected Initial State: RED` のテストが PASS している → テストが実装を検証できていない疑い。テストを書き直す（最大 2 回）
   - 既存の実装で通ってしまった場合は、テストの assertion を issue AC に合わせて強化する
4. 2 回リトライしても RED にならないテストは Test Plan から落とす理由を `kickoff.json.phases.4_implement.red_failures[]` に記録して次の sub-phase へ

#### Step 4b: Green — Implement to Pass

1. テストファイルは**変更せず**、実装コードのみ書いて全テストを GREEN にする
2. `dev-validate` で全テスト PASS を確認
3. Green 不成立時は実装を修正して再検証（最大 3 回）。それでも失敗するなら Evaluator feedback を待つ（phase 6 へ）

#### Step 4c: Refactor (optional)

1. テストが GREEN のまま、重複・命名・構造を整理
2. 各 refactor 後に `dev-validate` で回帰テスト
3. Refactor で test が RED 化したら即 revert

**Test Plan が無い場合**（standalone 実行 or `config.testing=none`）は上記 sub-phase をスキップし、従来通りの一括実装を行う。

Select tools based on `--type`. Follow project conventions, maintain existing patterns, add error handling, include imports.

Details: [Tool Selection](references/tool-selection.md)

**Feature trace logging (kickoff.json 連携)**:

`$WORKTREE/.claude/kickoff.json` に `feature_list` が存在する場合（`dev-plan-impl` で初期化済）、各 feature 完了時に以下を必ず呼び出す:

```bash
# 着手時
$SKILLS_DIR/dev-kickoff/scripts/update-feature.sh \
  --worktree "$WORKTREE" --id "F1" --status in_progress

# 完了時
$SKILLS_DIR/dev-kickoff/scripts/update-feature.sh \
  --worktree "$WORKTREE" --id "F1" --status done

$SKILLS_DIR/dev-kickoff/scripts/append-progress.sh \
  --worktree "$WORKTREE" --phase "4" --note "F1 (feature desc) 完了、test green"
```

**Mandatory rules**:
- `feature_list[i].id` と `desc` は **書き換え禁止**。`update-feature.sh` は `status` のみ変更する。
- `Edit` ツールで kickoff.json の `feature_list` を直接書き換えない。必ずスクリプトを使う。
- `progress_log` は append-only。既存エントリに触れない。
- Standalone モード: `feature_list` が未定義 or 空の場合（standalone 実行 / impl-plan.md 入力のみで起動した場合）はスキップして通常実装を続行する。

### Step 5: Validate

- [ ] Todos completed
- [ ] No TODO comments in code
- [ ] Types correct (TypeScript)
- [ ] Imports resolved
- [ ] Tests pass (if --with-tests)

### Step 6: Review

If `--safe`: security check on auth/data handling, input validation review, error handling coverage.

## Return Contract

dev-implement worker は完了時に **4 値 status enum** を含む JSON を返す。dev-kickoff の Phase 5/6
orchestrator はこの contract に従って分岐する。

| status | 必須追加フィールド | 意味 |
|---|---|---|
| `DONE` | (なし) | 実装完了、self-doubt なし |
| `DONE_WITH_CONCERNS` | `concerns: string[]` | 完了したが懸念を申告 → Phase 6 で重点監査 |
| `BLOCKED` | `blocking_reason: string` | 同アプローチでは進めない → **同アプローチ retry 禁止**、Phase 3 に reset |
| `NEEDS_CONTEXT` | `missing_context: string[]` | 不足情報あり → Phase 4 に再 dispatch (補足情報付き) |

全 status 共通の必須ベースフィールド: `status`, `branch`, `worktree_path`, `commit_sha`。
任意: `pr_url`, `phase_failed`, `error`。

詳細仕様（サンプル JSON、schema error 時の挙動）: [Return Contract](references/return-contract.md)

## Examples

Details: [Usage Examples](references/examples.md)

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-implement success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-implement failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

## Integration

- Receives context from `dev-issue-analyze` if in kickoff workflow
- Receives `WORKTREE_PATH` from `dev-kickoff-worker` (isolation: worktree) if worktree mode
- Receives `task_body` (verbatim paste) from `dev-kickoff` / `dev-kickoff-worker` when invoked as
  part of an orchestrated phase. **When `task_body` is provided, `$WORKTREE/.claude/impl-plan.md`
  is NOT Read.** See [Return Contract](references/return-contract.md) and
  [`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md).
- Falls back to reading `$WORKTREE/.claude/impl-plan.md` from `dev-plan-impl` only when no `task_body`
  is paste-supplied (standalone invocation).
- Passes to `dev-validate` skill for verification
- Receives Evaluator feedback via kickoff.json iterations on retry
- Returns 4-value `status` JSON per [Return Contract](references/return-contract.md)
