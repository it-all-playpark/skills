# Subagent Dispatch Rules (dev-kickoff phases)

dev-kickoff は Phase 2（`dev-issue-analyze` が内部で `Task(Explore)`）、Phase 3b（`dev-plan-review` が `context:fork`）、Phase 5（`dev-validate` が `Task(quality-engineer)`）、Phase 6（`dev-evaluate` が `context:fork`）で subagent を起動する。dev-kickoff 自体が sub-skill を呼び出す際、および sub-skill が Task/Agent を呼ぶ際の両方で、[共通規約](../../_shared/references/subagent-dispatch.md) の必須5要素を遵守する。

## Phase 2: dev-issue-analyze → Task(Explore)

1. **Objective** — 「issue `#$ISSUE` の受け入れ条件・影響ファイル・依存関係を抽出し、実装計画の入力となる構造化要件を返す」
2. **Output format** — `{ issue, acceptance_criteria: [...], impacted_files: [...], dependencies: [...], risks: [...] }` JSON
3. **Tools** — 使用可: Read, Grep, Glob, Bash (gh issue view のみ)。禁止: Write, Edit, commit, git branch 操作
4. **Boundary** — `$WORKTREE` 内の read-only 探索、`node_modules/`・`vendor/`・`dist/` 除外、git 書き込み禁止、ネットワーク最小限（gh issue view のみ許可）
5. **Token cap** — 2000 語以内、最大 30 ファイル参照

## Phase 3b: dev-plan-review（context:fork, opus）

1. **Objective** — 「`$WORKTREE/.claude/impl-plan.md` をレビューし、`{score, verdict, findings}` JSON 形式で verdict を返す」（pass/revise/block の単一判定）
2. **Output format** — `{ score: 0-100, verdict: "pass"|"revise"|"block", findings: [{ severity, dimension, topic, description, suggestion }], pass_threshold: 80, summary: string }` JSON
3. **Tools** — 使用可: Read, Grep, Glob。禁止: Write, Edit, Bash (git/ネットワーク含む), Task（再帰禁止）
4. **Boundary** — `$WORKTREE` 内の read-only、`impl-plan.md` の書き換え禁止（feedback は親が `plan-review-feedback.json` に書き出す）、親の state 変更禁止
5. **Token cap** — 1500 語以内、findings 最大 10 件

## Phase 5: dev-validate → Task(quality-engineer)

1. **Objective** — 「`$WORKTREE` で lint / type check / test を実行し、失敗箇所を列挙、`--fix` 時は安全な自動修正を適用する」
2. **Output format** — `{ verdict: "pass"|"fail", checks: [{ name, status, errors: [...] }], fixed_files: [...] }` JSON
3. **Tools** — 使用可: Read, Edit, Bash (lint/test 実行 `--fix` 時のみ Edit 許可)。禁止: Write（新規ファイル作成禁止）, git commit, git push, network
4. **Boundary** — `$WORKTREE` 配下のみ、`.git/` 直接編集禁止、main/dev への push 禁止、依存追加禁止（既存 lockfile は変更可）
5. **Token cap** — 1500 語以内、エラー報告は重要度順に最大 30 件

## Phase 6: dev-evaluate（context:fork, opus）

1. **Objective** — 「実装結果が issue の受け入れ条件を満たしているか評価し、`pass`/`fail`（+ design or implementation feedback）の verdict を返す」
2. **Output format** — `{ verdict: "pass"|"fail", feedback_type: "design"|"implementation"|null, score: 0-100, findings: [...], summary: string }` JSON
3. **Tools** — 使用可: Read, Grep, Glob, Bash（read-only 診断のみ）。禁止: Write, Edit, git 操作, Task（再帰禁止）
4. **Boundary** — `$WORKTREE` 内の read-only 評価、実装の書き換え禁止、親の phase state 変更禁止
5. **Token cap** — 1500 語以内、findings 最大 10 件

## Routing

- dev-issue-analyze の Explore → `general-purpose` (sonnet) / haiku 系
- dev-plan-review / dev-evaluate → `context:fork` で opus（Plan / code-reviewer 相当）
- dev-validate の quality-engineer → `general-purpose` (sonnet)
