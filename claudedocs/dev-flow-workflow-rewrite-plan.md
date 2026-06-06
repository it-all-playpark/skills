# dev-flow Workflow 書き直し計画

- 作成: 2026-05-31
- branch: `worktree-dev-flow-workflow-rewrite`
- 確定方針: **child-split 廃止 / ループ上限 plan 20・impl 10 / Claude 専用 (workflow 依存)**

## 0. 目的

dev-flow family の本質（下記 9 段階）だけを残し、`skill が中間結果を context に置く → ターン跨ぎ/compact で消える` を補うための **state 管理 script (~25 個) と child-split coordination 一式を全廃**する。中間結果は Workflow の JS 変数が持ち、判断系 leaf は subagent frontmatter で effort を固定する。

### 本質 9 段階 → Workflow phase マッピング

| # | 本質 | Workflow phase | 実装 |
|---|------|----------------|------|
| 1 | issue 確認 | `Analyze` | agent (dev-issue-analyze 相当) |
| 2 | 実装計画 + 並列/直列分解 | `Plan` | agent `dev-planner` が `{serial:[], parallel:[]}` を返す |
| 3 | 計画レビュー→指摘→OK まで **(上限20)** | `Plan` 内 while | `dev-planner` ⇄ `plan-reviewer` ループ |
| 4 | 必要ならテスト実装 | `Implement` | implementer に `--testing tdd/bdd` 指示 |
| 5 | 実装（並列/直列） | `Implement` | `parallel()` + 直列 for |
| 6 | テスト/format/lint green | `Validate` | agent が test + lint + format を実行、exit 0 確認 |
| 7 | 意図通りかレビュー→差し戻し **(上限10)** | `Evaluate` 内 while | `evaluator` ⇄ implementer ループ |
| 8 | PR 作成 | `PR` | agent が git-commit + git-pr skill 実行 |
| 9 | PR レビュー→fix→LGTM | `workflow('pr-iterate')` | **独立 workflow** をサブ呼び（上限10） |

`/goal` は workflow にネスト不可（goal=セッションスコープ Stop hook / workflow=背景隔離 run）。よって **goal の generator-evaluator モデルは各 phase の while ループ + 別 agent verifier で再現**する（上表 3/7/9）。

### 確定事項（ユーザー決定 2026-05-31）
- **leaf は基本 subagent 一本化**（旧 skill 削除、no dual-path）。
- **pr-iterate は独立 workflow として残す** — よく使うため。`.claude/workflows/pr-iterate.js` を作り、dev-flow からは `workflow('pr-iterate', {pr})` でサブ呼び（docs 上ネスト1段まで可）、単体 `/pr-iterate <pr>` でも起動可能。
- **dev-validate の format/lint は hook 領域へ寄せる** — 決定論処理は AI に任せない（§4-B）。test green 確認のみ workflow に残す。
- **journal**: workflow 完走後に main loop が 1 回だけ success/failure 記録。agent 内 journal は廃止。
- **dev-flow-doctor**: 今回スコープ外・別 issue。

---

## 1. 最終アーキテクチャ

```
/dev-flow <issue>                       ← .claude/workflows/dev-flow.js
  └─ phase Analyze   → agent(dev-issue-analyze skill 呼び)
  └─ phase Plan      → while(i<20){ dev-planner ⇄ plan-reviewer }
  └─ phase Implement → serial: for / parallel: parallel()  (implementer, isolation:'worktree')
  └─ phase Validate  → agent: test green のみ（format/lint は hook 責務）
  └─ phase Evaluate  → while(i<10){ evaluator ⇄ implementer }
  └─ phase PR        → agent: git-commit + git-pr (skill 呼び)
  └─ workflow('pr-iterate', {pr})        ← サブ workflow 呼び（ネスト1段）

/pr-iterate <pr>                        ← .claude/workflows/pr-iterate.js（単体起動も可）
  └─ while(i<10){ pr-reviewer ⇄ pr-fix } until LGTM

判断系 subagent (.claude/agents/*.md, effort:max 固定):
  dev-planner / plan-reviewer / evaluator / pr-reviewer  (model:opus)
  implementer (model:sonnet)
```

### なぜ subagent 化するか（memory gotcha）
- Workflow の `agent()` には **effort 引数が無い（model のみ）**。per-phase で effort:max を効かせたい判断系は **subagent frontmatter の `effort` で固定するしかない**。
- `agentType` と `schema` は composable（subagent 定義 + workflow 側で構造化出力強制が両立）。
- **gotcha**: subagent 定義はセッション開始時に登録される。新規作成 agent は同一セッションでは `agent type not found`。→ 手順は「agent 追加 → セッション reload → workflow 実行」。

---

## 2. ファイル仕分け

### 🆕 新規作成

| パス | 内容 | model/effort |
|------|------|--------------|
| `.claude/workflows/dev-flow.js` | workflow script 本体（6 phase + 2 while ループ + pr-iterate サブ呼び） | — |
| `.claude/workflows/pr-iterate.js` | **独立 workflow**。review ⇄ fix ループ（上限10）。単体 `/pr-iterate <pr>` でも起動 | — |
| `.claude/agents/dev-planner.md` | dev-plan-impl 移植。`{serial:[], parallel:[], feature_list:[]}` 返す | opus / max |
| `.claude/agents/plan-reviewer.md` | dev-plan-review 移植。`{score, verdict, findings, summary}` | opus / max |
| `.claude/agents/implementer.md` | dev-implement 移植。`{status, files, notes}` | sonnet / high |
| `.claude/agents/evaluator.md` | dev-evaluate 移植。`{verdict, score, feedback, feedback_level}` | opus / max |
| `.claude/agents/pr-reviewer.md` | pr-review 移植。`{decision, issues, summary(ja)}`（memory PoC 済） | opus / max |

### ✅ 残す（workflow agent が Skill として呼ぶ / portable 維持）

| skill | 理由 |
|-------|------|
| `git-commit` / `git-pr` | portable 汎用 skill。subagent 化せず agent prompt から Skill 呼び |
| `pr-fix` | fix 適用。pr-iterate workflow 内で agent が使用 |
| `dev-issue-analyze` | issue 分析。standalone でも有用なので skill 維持、agent から呼ぶ |

`dev-validate` は **§4-B の通り再編** — format/lint は hook へ、test green は workflow Validate phase 内 agent へ。skill 本体は削除。

### ❌ 削除（state 足場 / child-split / orchestrator）

**orchestrator 本体（workflow が代替）**
- `dev-flow/`（SKILL.md, preflight.sh, flow-status.sh, auto-merge-child.sh, references/）
- `dev-kickoff/`（SKILL.md, init-kickoff.sh, update-phase.sh, append-progress.sh, update-feature.sh, next-action.sh, test-status-branching.bats）
- `.claude/agents/dev-kickoff-worker.md`（isolation は workflow `agent({isolation:'worktree'})` で代替）

**判断系 leaf（subagent へ移植 → 旧 skill 削除、no dual-path）**
- `dev-plan-impl/` → `dev-planner.md` へ
- `dev-plan-review/` → `plan-reviewer.md` へ
- `dev-implement/` → `implementer.md` へ
- `dev-evaluate/` → `evaluator.md` へ
- `pr-review/` → `pr-reviewer.md` へ
- `pr-iterate/` SKILL.md + state script（init-iterate, record-iteration, check-resume, post-summary, pr-iterate-setup）→ **`.claude/workflows/pr-iterate.js` へ移植**。ループは while + JS 変数。`check-ci.sh` / `check-lgtm.sh` は決定論なので agent が Bash 実行 or 小 helper として残す検討

**child-split 一式（廃止）**
- `dev-decompose/`（create-child-issues.sh, init-flow-v2.sh）
- `dev-integrate/`（verify-children-merged.sh）
- `_lib/scripts/flow-read.sh` / `flow-update.sh` / `validate-decomposition.sh` / `integration-branch.sh`
- `_shared/scripts/run-batch-loop.sh`
- `_lib/scripts/pre-compact-save.sh`（resume は workflow `resumeFromRunId` が代替）
- `_shared/scripts/termination-record.sh`（終了判定は JS while へ）
- `_lib/scripts/auto-merge-guard.sh`（child 自動 merge 廃止）

### ⏸ スコープ外（今回触らない）

| skill | 扱い |
|-------|------|
| `dev-flow-doctor` | observability。journal 依存部は生きるが kickoff.json/flow.json 依存の分析は壊れる。**別 issue で workflow 対応**（今回は放置 = 一部機能停止を明記） |
| `dev-build` / `dev-cleanup` / `dev-env-setup` | dev-flow family 外。無関係 |
| `skill-retrospective` journal | §5 参照 |

---

## 3. workflow script の骨格（dev-flow.js）

```js
export const meta = {
  name: 'dev-flow',
  description: 'Issue から LGTM までの開発フロー（plan→review→implement→validate→evaluate→PR→iterate）',
  phases: [
    { title: 'Analyze' }, { title: 'Plan' }, { title: 'Implement' },
    { title: 'Validate' }, { title: 'Evaluate' }, { title: 'PR' }, { title: 'PR-iterate' },
  ],
}
const ISSUE = args.issue, BASE = args.base ?? 'dev', TESTING = args.testing ?? 'tdd'

// 1. Analyze
phase('Analyze')
const req = await agent(`issue #${ISSUE} を分析し受入条件を抽出`, { schema: REQ })

// 2-3. Plan（計画 ⇄ レビュー、上限20）
phase('Plan')
let plan, feedback = null
for (let i = 1; i <= 20; i++) {
  plan = await agent(planPrompt(req, feedback), { agentType: 'dev-planner', schema: PLAN })
  const rev = await agent(reviewPrompt(plan), { agentType: 'plan-reviewer', schema: VERDICT })
  if (rev.verdict === 'pass') break
  if (rev.verdict === 'block' && i >= 20) throw new Error('plan unresolved')
  feedback = rev.findings   // 次 iteration へ
}

// 4-5. Implement（直列→並列、worktree isolation）
phase('Implement')
for (const t of plan.serial)  await agent(implPrompt(t, TESTING), { agentType: 'implementer', isolation: 'worktree' })
await parallel(plan.parallel.map(t => () =>
  agent(implPrompt(t, TESTING), { agentType: 'implementer', isolation: 'worktree' })))

// 6. Validate（test + lint + format green）
phase('Validate')
let val = await agent(`test/lint/format を実行し exit 0 を確認、緑でなければ修正`, { schema: GREEN })
// (green まで内部リトライ or fail report)

// 7. Evaluate（意図通りか ⇄ 差し戻し、上限10）
phase('Evaluate')
for (let i = 1; i <= 10; i++) {
  const ev = await agent(evalPrompt(req, plan), { agentType: 'evaluator', schema: EVAL })
  if (ev.verdict === 'pass') break
  const target = ev.feedback_level === 'design' ? 'dev-planner' : 'implementer'
  await agent(fixPrompt(ev.feedback), { agentType: target, isolation: 'worktree' })
}

// 8. PR
phase('PR')
await agent(`git-commit --all 後 git-pr ${ISSUE} --base ${BASE} を実行し PR URL を返す`, { schema: PRURL })

// 9. PR-iterate（review ⇄ fix、LGTM まで 上限10）
phase('PR-iterate')
for (let i = 1; i <= 10; i++) {
  const r = await agent(`PR #${pr} をレビュー`, { agentType: 'pr-reviewer', schema: REVIEW })
  if (r.decision === 'approve') break
  await agent(`pr-fix で ${r.issues.length} 件を修正`, { agentType: 'implementer' })
}
return { issue: ISSUE, pr, status: 'done' }   // merge は手動
```

ポイント:
- **state script 0**: ループカウンタ・verdict history・feature status は全部 JS 変数
- **schema で構造化出力強制**: verdict / decision の enum を JSON schema で固定（no-backcompat = 最新 const）
- **resume**: `resumeFromRunId` で完了 agent はキャッシュ返し → pre-compact-save 不要
- **merge しない**: 本質通り PR-iterate 完走 = LGTM で終了、merge は手動

---

## 4. 本質に対する「不足」修正点 + dev-validate 再編

1. **task 単位の並列分解（本質 #2）を single 内で実現** — child issue 不要。`plan.parallel` を `parallel()` でファンアウト。
2. **ループ上限を本質値に** — Plan 3→**20** / Evaluate 5→**10** / PR-iterate 10（据置）。

### 4-B. dev-validate の再編（format/lint は AI 領域外）

本質 #6「テスト・フォーマッター・リンターが green」を、**決定論部分(format/lint)と判断部分(test 修正)で分離**する。RULES.md「毎回確定実行したい挙動は hook」原則に沿う。

| 対象 | 現状 | 移行先 | 理由 |
|------|------|--------|------|
| format（prettier 等） | dev-validate 内 | **PostToolUse hook**（Edit/Write 後に自動）or pre-commit | 完全決定論。AI 判断不要。毎回確定実行したい |
| lint（eslint 等） | dev-validate 内 | **pre-commit hook**（commit 時に自動） | 決定論。違反は機械的に検出 |
| test 実行 + 落ちたら修正 | dev-validate 内 | **workflow Validate phase（agent）** | テスト実行は決定論だが「落ちた原因を分析して直す」は AI 領域 |

- **現状 hook は未整備**（skills repo に pre-commit/PostToolUse format hook 無し）。→ hook は dotfiles repo の `claude-code/hooks/` に新規追加（別タスク扱い、本書では「workflow から format/lint 責務を外す」方針のみ確定）。
- workflow の Validate phase は「`npm test` 等を走らせ、green でなければ implementer に差し戻し」に絞る。format/lint の緑化は workflow の責務から外す。
- `dev-validate` skill 本体・validate.sh・validate-kickoff.sh は削除。

---

## 5. 決定済み論点（2026-05-31）

| # | 論点 | 決定 |
|---|------|------|
| A | standalone leaf skill | **subagent 一本化（旧 skill 削除）**。例外: pr-iterate は独立 workflow で残す |
| B | journal 連携 | **完走後に main loop が 1 回記録**（success/failure）。agent 内 journal 廃止 |
| C | dev-flow-doctor | **今回スコープ外・別 issue**。SKILL に「workflow 移行で kickoff.json/flow.json 依存分析が一部停止」と注記 |
| D | dev-validate | **再編（§4-B）**。format/lint は hook、test green は workflow。skill 削除 |

---

## 6. 移行手順（実装フェーズ）

1. `.claude/agents/` に 5 subagent 定義を作成（dev-planner / plan-reviewer / implementer / evaluator / pr-reviewer）
2. `.claude/workflows/dev-flow.js` 作成
3. **セッション reload**（subagent 登録のため。gotcha 回避）
4. `dev-validate` を `{tests, lint, format}` green schema に修正
5. 実 issue で縦切り実行 → 動作確認
6. 旧 skill / state script を削除（§2 ❌ リスト）
7. AGENTS.md / docs の dev-flow v2 記述を workflow ベースに更新
8. bats テスト整理（削除 skill のテストを除去、workflow は手動検証）

---

## 7. リスク

- **research preview 依存**: workflow は v2.1.154+ research preview。仕様変更リスク。→ Claude 専用化は既に合意済み。
- **subagent reload gotcha**: 手順 3 を飛ばすと `agent type not found`。
- **削除の不可逆性**: child-split を本当に使っていないか最終確認（過去 PR で実運用があれば git 履歴に残るが、本質には不要と確認済み）。
- **effort 固定の検証**: agent() に effort 無し → subagent frontmatter で効いているか実行ログで確認。
