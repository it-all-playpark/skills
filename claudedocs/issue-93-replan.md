# issue #93 立て直し計画 (最新 main ベース)

- 更新日: 2026-05-15
- 状態: 計画段階（実装未着手）
- 元 issue: [#93 feat(dev-flow): DAG/wave を捨て child-issue + integration branch + batch loop に統一](https://github.com/it-all-playpark/skills/issues/93)
- 関連 PR (closed): #98 (dev → 直接 main にせず dev に merge してしまった), #99 (dev → main の conflict 解消不能で close)

## なぜ立て直すか

PR #98 で issue #93 の計画はほぼ完遂した（60 ファイル、+3147 / -4406 行）。しかし feature/issue-93-m を `dev` base で作ってしまったため、dev → main の PR #99 が main 側 73 commits との大量 conflict で詰まった。

経緯:
- 2026-05-14: PR #98 を `feature/issue-93-m → dev` で merge
- 2026-05-15: PR #99 (dev → main) 作成 → CONFLICTING
- 同日: origin/dev を origin/main に force reset、PR #99 close、PR #98 の 11 commits は revert

PR #98 の 11 commits は **revert 済み** だが、SHA は local reflog で参照可能（`982d46f..edd6b3f` の範囲）。後述 commits の cherry-pick 元として利用できる。

## ゴール (issue #93 から引き継ぎ、不変)

DAG / wave 概念を捨て、以下に統一:

1. **child-issue 分割**: 親 issue を外部 GitHub child issue 群に分解
2. **integration branch**: child PR の merge target に `integration/issue-{N}-{slug}` を作成
3. **batch 配列**: 依存関係は `[{mode: seq|parallel, issues: [...]}]` で表現
4. **batch loop 共通化**: `_shared/scripts/run-batch-loop.sh` （night-patrol Phase 3 から抽出）
5. **auto-merge guard**: base が `integration/issue-*` / `nightly/*` の時のみ `--admin` merge 許可

## main 側で並行で進んだ変更（PR #98 計画時には存在しなかった）

PR #98 の base point (`982d46f`, PR #70 merge) 以降に main へ取り込まれた重要要素:

| 変更 | 由来 PR | issue #93 立て直しへの影響 |
|------|---------|--------------------------|
| `dev-contract-worker` subagent (`.claude/agents/`) | #87, #90 | ❌ **撤回対象**: child-split では contract branch 機構自体を捨てるため不要 |
| `dev-kickoff-worker` の `mode: merge` パターン | #82 | ❌ **撤回対象**: dev-integrate の Kahn 法 merge を廃止するため `mode: merge` も不要 |
| `dev-kickoff-worker` の `mode: parallel` | #82 | ❌ **撤回対象**: subtask DAG 廃止に連動 |
| 4 値 status enum (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT) | #92 | ✅ **維持**: child-split mode と直交、影響なし |
| adversarial opener (dev-plan-review / dev-evaluate) | #92 | ✅ **維持**: child PR の品質ゲートで活用 |
| no-backcompat 原則明文化 (CLAUDE.md, skill-creation-guide.md) | #91, #96 | ✅ **維持・強化**: flow.schema v2 を schema error 即時 reject に活用 |
| `_shared/references/worker-dispatch.md` (共通化) | #91 | ✅ **維持**: child-split でも worker dispatch 規約は共通使用 |
| `dev-flow-doctor` 改善 (status code ベース stuck 検知 等) | #83, #88 | ⚠️ **要調整**: parallel-mode 関連の diagnostic を child-split mode 用に書き換え |
| `_shared/references/subagent-dispatch.md` に paste/status 規約追記 | #92 | ✅ **維持**: child-split でも適用 |

## PR #98 と main 現状の整合性 summary

- ✅ **方向性は整合**: 両者とも worker subagent + no-backcompat + status enum の方針を堅持
- ❌ **設計コンフリクト**: PR #98 は contract branch / parallel mode / Kahn 法 merge を **撤廃** する一方、main 側は同じ機構を **worker subagent 化で強化** していた → 後者を捨てる方向で進む（issue #93 の方針が優先）
- ⚠️ **dev-flow-doctor の追加調整**: parallel-mode 廃止に伴い diagnostic を child-split mode 用に再設計

## 立て直し後の commits リスト

PR #98 の 9 commits を main の現状に合わせて調整、+ dev-flow-doctor の調整 1 commit を追加。

| # | 内容 | 流用元 (cherry-pick) | conflict 想定 | 調整点 |
|---|------|---------------------|--------------|--------|
| 1 | `feat(_shared): run-batch-loop.sh を新設` | fd8fdf8 | なし（新規ファイル） | なし |
| 2 | `feat(_lib): auto-merge-guard.sh を新設` | 12aa7c1 | なし（新規ファイル） | なし |
| 3 | `feat(_lib): integration-branch.sh helper を新設` | ba3e13d | なし（新規ファイル） | なし |
| 4 | `feat(_lib/schemas): flow.schema.json v2 (batch 配列) に置換` | 7b73d5c | 軽（v1 schema を v2 で置換） | no-backcompat 原則を CLAUDE.md 引用で強調 |
| 5 | `refactor(dev-decompose): child-issue 分割モードに書き換え` | efc8f0c | **重**: dev-decompose 全面書き換え | **dev-contract-worker dispatch コード削除**、main の worker dispatch refs を child-issue 作成 worker に転用、**連続 seq batch を 1 child issue に自動統合する正規化ロジック追加**（内部 task は GitHub issue tasklist `- [ ]` で表現、例外的に分けたい場合は手動 override。分ける条件: owner 違い / size 過大 / rebase 都合）|
| 6 | `refactor(dev-flow): Mode Decision を single \| child-split に変更` | 936494e | **重**: dev-flow Mode Selection 書き換え | `--force-parallel` / `--parallel` (deprecated alias) を完全削除、auto-detect (dev-decompose --dry-run) も削除 |
| 7 | `feat(git-pr): --draft フラグを文書化し dev-flow child-split から指定` | 1b77c0b | 軽 | なし |
| 8 | `refactor(dev-kickoff,dev-integrate,dev-kickoff-worker): parallel mode + Kahn 法 + mode:parallel/merge を削除` | aec3305 | **重**: 多数の参照削除 | PR #98 比で追加削除: `dev-kickoff-worker.md` の `mode: parallel \| merge` 分岐、`_shared/references/shared-findings.md`、`_shared/references/integration-feedback.md`、`_shared/scripts/flow-append-finding.sh` / `flow-read-findings.sh` / `integration-event-*.sh` / `detect-stuck-findings.py`、`dev-integrate/scripts/merge-subtasks.sh`、`dev-integrate/scripts/check-unacked-findings.sh`、`dev-kickoff/references/parallel-mode.md`、`_lib/scripts/topo-sort.sh`、`_lib/scripts/merge-subagent-result.sh` |
| 9 | `chore(.claude/agents): dev-contract-worker.md を削除 + dev-kickoff-worker.md の mode を single 固定に` | **新規** | **重**: agent 定義削除 | PR #98 にはなかった作業。main で #87/#90 で導入された agent を撤回 |
| 10 | `refactor(dev-flow-doctor): child-split mode 用 diagnostic に書き換え` | **新規** | 中: parallel-mode 由来の dead phase / stuck skill heuristics を child-split 用に書き換え | PR #98 にはなかった作業 |
| 11 | `chore(night-patrol): --force-single 付与` + `docs(skills): 新設計と CI skip recipe を追記` | fa5da78 | 軽 | docs/skill-creation-guide.md は main 側で frontmatter 15 フィールド説明等が追加されているため、追記箇所を merge |
| 12 | `fix(dev-flow): PR #98 review feedback を反映` | edd6b3f | 軽 | auto-merge-child.sh の fuzzy search 廃止、run-batch-loop.sh --fail-fast、validate-decomposition.sh issue regex、auto-merge-guard.sh pattern reject、tests/run-all-bats.sh など |

合計 12 commits（PR #98 比で +3、PR #98 の 9 を継承 + 新規 3）。

## 受け入れ基準

issue #93 body から引き継ぎ、main 整合のため 4 項目追加:

- [ ] `_shared/scripts/run-batch-loop.sh` が存在し、`--batch-from N --batch-to N` で範囲実行できる
- [ ] `_lib/scripts/auto-merge-guard.sh` が `integration/issue-*` / `nightly/*` 以外への `--admin` merge を refuse する
- [ ] `_lib/scripts/integration-branch.sh` が parent issue から integration branch を create / cleanup できる
- [ ] `_lib/schemas/flow.schema.json` v2 (batch 配列) のみ受理、v1 (depends_on DAG) は schema error
- [ ] `dev-decompose <issue> --child-split` が child issue 群 + integration branch + batch 配列 flow.json を生成
- [ ] `dev-flow <issue> --child-split` が child を batch loop で自動消化 → 最終 integration PR を作成
- [ ] `dev-flow <issue> --force-single` が auto-detect なしで single mode に直行
- [ ] `night-patrol` Phase 3 が `dev-flow <child-issue> --force-single` で起動
- [ ] `dev-kickoff` から `--task-id` / `--flow-state` / `references/parallel-mode.md` が削除されている
- [ ] `dev-integrate` の Kahn 法 topological sort (`merge-subtasks.sh`) が削除され、`verify-children-merged.sh` のみ
- [ ] **追加**: `.claude/agents/dev-contract-worker.md` が削除されている
- [ ] **追加**: `.claude/agents/dev-kickoff-worker.md` の `mode` parameter が `single` 固定（`parallel` / `merge` 分岐削除）
- [ ] **追加**: `_shared/` から `shared-findings.md` / `integration-feedback.md` / `flow-append-finding.sh` / `flow-read-findings.sh` / `integration-event-*.sh` / `detect-stuck-findings.py` が削除
- [ ] **追加**: `dev-flow-doctor` の diagnostic が child-split mode 用に書き換えられている（parallel mode 由来の heuristics 廃止）
- [ ] `docs/skill-creation-guide.md` / `CLAUDE.md` / `docs/ci-skip-recipe.md` 更新
- [ ] `skill-config.json` に `max_child_issues: 8 / 12` + `auto_merge_allowed_base_patterns` 追加
- [ ] 既存 night-patrol が同じ outcome で動作する (regression なし)
- [ ] 4 値 status enum (issue #92) との直交性を維持（child-split 内の各 child は引き続き status enum で意思疎通）
- [ ] adversarial review skill (dev-plan-review / dev-evaluate) は維持、child PR にも適用

## Model / Effort 割り振り

各 skill の frontmatter `model` / `effort` 方針：

| 種別 | model | effort | 対象 skill |
|------|-------|--------|----------|
| 計画 / 設計 / レビュー / 評価（熟考系） | opus | max | dev-plan-impl, dev-plan-review, dev-evaluate, dev-decompose |
| 実装 / コード生成 | sonnet | 省略（session 設定継承、通常 high） | dev-implement, dev-flow, dev-kickoff |
| 軽い判断を伴う処理 | sonnet | medium | dev-issue-analyze |
| 決定論的 wrap / CLI / format 変換 | haiku | low | dev-validate, git-commit, git-pr, dev-flow-doctor, dev-cleanup |

判断基準（[`docs/skill-creation-guide.md`](../docs/skill-creation-guide.md) の effort セクションに準拠）:

- **推論の質が出力品質を決定する skill**（planning, review, critique, strategy）→ opus + max
- **コード生成・通常ワークフロー** → sonnet（effort は省略推奨、session 設定継承で予測可能性を確保）
- **決定論的 tool wrapper** → haiku + low

`run-batch-loop.sh` / `auto-merge-guard.sh` / `integration-branch.sh` などの **bash script は model 設定そのものが不要**（LLM を呼ばない pure bash）。Commit 5-12 で各 skill の frontmatter を見直す際、この表に従って整合させる。

## PR 戦略

**Single PR (force-single) で 12 commits を main 直接 PR**:

- base: `main`
- branch: `feature/issue-93-redo`
- bootstrap problem: child-split mode を実装する本 issue 自体は child-split できない → single mode で land

```bash
# 推奨手順
git checkout -b feature/issue-93-redo origin/main

# Commits 1-3: 新規ファイル (conflict なし、cherry-pick 即成功)
git cherry-pick fd8fdf8 12aa7c1 ba3e13d

# Commit 4: schema 置換 (軽い conflict)
git cherry-pick 7b73d5c
# → CLAUDE.md no-backcompat 引用を確認

# Commit 5: dev-decompose 書き換え (重 conflict)
git cherry-pick efc8f0c
# → dev-contract-worker dispatch コードを削除、worker refs を child-issue 作成 worker に転用

# ... 以下 commit 12 まで同様
```

## 着手前に確認すべきこと

- [ ] 旧 flow.json (v1 / DAG 形式) の **in-flight 作業が main で動いていない** こと
  - `git log --since=2026-05-01 --grep="flow.json"` で確認
  - 現在 worktree (`~/ghq/github.com/it-all-playpark/skills/.worktrees/`) を確認
- [ ] dev-contract-worker が `dev-decompose` 以外から呼ばれていないこと
  - `grep -rn "dev-contract-worker" --include="*.md" --include="*.sh"` で参照箇所確認
- [ ] dev-kickoff-worker の `mode: parallel | merge` を実際に使っている呼び出し元が dev-decompose / dev-integrate 以外にないこと

## Out of scope (issue #93 から引き継ぎ)

- 旧 in-flight 作業の自動移行 (user が手動で land or abandon)
- 親 issue 跨ぎの依存表現 (将来の拡張)
- Dynamic re-planning (実行中の child 追加)
- 4 値 status enum の child-split 仕様への拡張 (現状の single-child 内で完結)

## References

- 元 issue: [#93](https://github.com/it-all-playpark/skills/issues/93)
- revert された PR: [#98](https://github.com/it-all-playpark/skills/pull/98)
- conflict で close した PR: [#99](https://github.com/it-all-playpark/skills/pull/99)
- PR #98 の merge commit: `f90b179a83d172b5a2adb177d354d9ed254b928b` (cherry-pick 元として local reflog で参照可能)
- 関連: CLAUDE.md no-backcompat 原則、`_shared/references/subagent-dispatch.md`、`docs/skill-creation-guide.md`
