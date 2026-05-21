# Portable Coordinator — Cross-Agent Harness Reference

Cross-vendor coding agent (Claude Code / Codex CLI / Antigravity / Cursor / Amp) で
**同じ harness** を動かすための設計と検証結果。本リポの orchestration を vendor-lockin から
解放する基礎ドキュメント。

実機検証日: **2026-05-21**
対象バージョン: Claude Code v2.1.145, Codex CLI v0.132, Antigravity v1.0.0

---

## 1. Background

### Why portable?

coding agent (Claude Code, Codex CLI, Antigravity, Cursor, Amp 等) が短期間に乱立。
本リポの skill / orchestration は Claude Code 専用に最適化されてきた:

- subagent (`isolation: worktree`, `context: fork`)
- frontmatter 拡張 (`allowed-tools`, `model`, `effort`, `user-invocable` 等)
- `Skill` / `Agent` tool を介した session 内 dispatch

しかし以下の事情で「Claude Code 専用に閉じる」のはリスク:

1. **2026-06-15 から `claude -p` が Agent SDK credit 別課金**になる ($20-$200/月)
2. **業界トレンド**: AGENTS.md / SKILL.md が Linux Foundation AAIF 配下の cross-vendor 標準に
   (Anthropic + OpenAI + Google + Sourcegraph + Cursor + Factory 共同推進)
3. **Codex CLI / Antigravity の急速な機能拡充**: 同等の skill / subagent 機構を持つようになった

### 目的

- 同じ harness (decision logic, state machine, validators) を Claude/Codex/agy で動かす
- agent ごとの差分を **薄い adapter 層** に閉じ込める
- Claude Code 固有機能 (`isolation: worktree`, `context: fork`) は **portable な代替**を用意

### 関連 issue

- [#101](https://github.com/it-all-playpark/skills/issues/101): CLAUDE.md → AGENTS.md 移行 (完了)
- [#103](https://github.com/it-all-playpark/skills/issues/103): SKILL.md portable subset 化 (作業中)

---

## 2. Architecture

3 層構造で responsibility を分離:

```
┌─ Layer 1: Portable core (1 個、全 agent 共有) ────────────────┐
│  • Skill 本体 (SKILL.md portable subset: name/description+body) │
│  • Decision script (bash, _lib/scripts/*-next.sh)              │
│  • State management (flow.json, kickoff.json)                  │
│  • Validators (_lib/scripts/validate-*.sh)                     │
│  • Adapter helpers (invoke-skill-poc.sh, worktree-*.sh)        │
└────────────────────────────────────────────────────────────────┘
                          ↑
                  各 agent から共通利用
                          ↓
┌─ Layer 2: Decision script ──────────────────────────────────────┐
│ 「次にどの skill を呼ぶか」「retry / abort 判定」を              │
│  deterministic に bash で表現。LLM の判断は呼ばない。            │
└─────────────────────────────────────────────────────────────────┘
                          ↑
┌─ Layer 3: Agent adapters (各 agent 1 個ずつ、薄い) ─────────────┐
│  • Claude Code: claude --bg + state.json polling                │
│  • Codex CLI:   codex exec --json --output-last-message         │
│  • Antigravity: agy -p (stdout 直接)                            │
│  • Cursor/Amp:  未対応 (将来)                                    │
└─────────────────────────────────────────────────────────────────┘
```

**設計原則**:

- **判断と実行の分離**: LLM 判断は skill 内部、順序・retry は bash
- **State machine は flow.json で明示**: 各 phase の status / attempts / score / retry_target を JSON で
- **Backpressure は portable**: validators (lint/test/type/schema) は agent 非依存
- **Computational > inferential**: Birgitta Böckeler のフレーミング — deterministic な制御を厚く

参照: [Harness Engineering for Coding Agents — Böckeler 2026-04](https://martinfowler.com/articles/harness-engineering.html)

---

## 3. Agent Runtime Matrix

実機検証ベース。3 agent 全てで「同一 prompt から同一 raw response を取得」を確認済。

| 観点 | Claude Code | Codex CLI | Antigravity (agy) |
|---|---|---|---|
| バージョン | v2.1.145 | v0.132 | v1.0.0 |
| Spawn 構文 | `claude --bg "<prompt>"` | `codex exec --json --output-last-message <file> "<prompt>"` | `agy -p "<prompt>"` |
| 実行モデル | async (background daemon) | sync (foreground) | sync (foreground) |
| 出力取得 | `~/.claude/jobs/<id>/timeline.jsonl` の最終行 `.text` | `<file>` に raw text | stdout 直接 |
| State 監視 | `~/.claude/jobs/<id>/state.json` polling | exit code | exit code |
| 課金 | 通常 quota (✅ `claude -p` 課金回避) | 通常課金 | 通常課金 |
| Sandbox 制御 | `--permission-mode` | `--sandbox read-only \| workspace-write \| danger-full-access` | `--sandbox` |
| Slash command (`/skill`) | ✅ 動作確認済 | ✅ 動作確認済 | ✅ 動作確認済 |
| Subagent 機構 | `.claude/agents/*.md` + `Agent` tool | `~/.codex/...` (要確認) | plugin 機構 |
| Worktree isolation | `isolation: worktree` frontmatter | 機構なし → bash で代替 | 機構なし → bash で代替 |

### Claude Code: `claude --bg` の動作詳細

- **`--bg` は v2.1.145 で hidden flag** (`claude --help` には未掲載だが実装済)
- session id を stdout に出力 (`backgrounded · <short-id>`)
- `~/.claude/jobs/<short-id>/state.json` に state、`timeline.jsonl` に進行ログ
- `state.json.state` の遷移: `working` → `{ done | blocked | stopped | failed }`
- `state.json.output.result` は **LLM が生成した要約サマリ**、raw response じゃない
- **生応答は `timeline.jsonl` 最終行の `.text`** ← これが正解

### Codex CLI: `codex exec` の動作詳細

- 同期実行 (foreground)、progress を stderr、final agent message を stdout
- `--json` で JSONL 形式の event stream
- `--output-last-message <file>` で最終 message のみファイルに書き出し ← 一番扱いやすい
- `--sandbox read-only` で読み取り専用、approval 不要で auto mode classifier 通過
- skill 自動 discovery 時に既存 SKILL.md (Claude 拡張 frontmatter 入り) で parse error
  ⇒ [#103](https://github.com/it-all-playpark/skills/issues/103) で portable subset 化対応中

### Antigravity (agy): `agy -p` の動作詳細

- 一番シンプル: `agy -p "<prompt>"` で sync 実行、stdout に raw response 直接
- ANSI escape sequence なし、bash parser に優しい
- `--dangerously-skip-permissions` で auto-approve
- skill 概念は plugin 経由 (`agy plugin install/list/...`)
- Vercel skills.sh ecosystem を内蔵 (`/find-skills react testing` で skills.sh から候補返す)

---

## 4. Skill Invocation Contract

### `invoke_skill` 関数の I/O 仕様

実装: `_lib/scripts/invoke-skill-poc.sh`

```
Usage:
  AGENT_RUNTIME=<claude|codex|agy> bash invoke-skill-poc.sh '<prompt>'

Env:
  AGENT_RUNTIME  claude | codex | agy  (default: claude)
  TIMEOUT_SEC    timeout seconds       (default: 300)

Output:
  stdout: raw LLM response text
  stderr: progress / errors

Exit:
  0  success
  1  invalid usage
  2  agent runtime error
  3  timeout
  4  unsupported AGENT_RUNTIME
```

### 使用例

```bash
# 単発 prompt
result=$(AGENT_RUNTIME=agy bash _lib/scripts/invoke-skill-poc.sh \
  'Reply ONLY this JSON: {"score":85,"verdict":"pass"}')
score=$(echo "$result" | jq -r '.score')

# slash command 起動 (3 agent 全部で動作確認済)
result=$(AGENT_RUNTIME=codex bash _lib/scripts/invoke-skill-poc.sh \
  '/dev-plan-review 79 --worktree /path')
```

### Adapter implementations (要点)

```bash
# Claude Code
short_id=$(claude --bg "$prompt" | grep -oE 'backgrounded · [a-f0-9]+' | awk '{print $3}')
while [ "$(jq -r '.state' ~/.claude/jobs/$short_id/state.json)" != "done" ]; do sleep 2; done
tail -1 ~/.claude/jobs/$short_id/timeline.jsonl | jq -r '.text'

# Codex CLI
out=$(mktemp); codex exec --json --output-last-message "$out" --sandbox read-only "$prompt" >/dev/null
cat "$out"

# Antigravity
agy -p "$prompt"
```

各 adapter は **5-15 行**。N 個の agent 対応でも複雑度は線形。

### Live regression test

`_lib/scripts/invoke-skill-poc.bats` に dry checks + live API tests。
live は `RUN_PORTABLE_POC_TESTS=1` で gating (各実行が quota 消費するため default skip)。

```bash
RUN_PORTABLE_POC_TESTS=1 bats _lib/scripts/invoke-skill-poc.bats
```

---

## 5. Worktree Adapter

Claude Code 固有の `isolation: worktree` の portable 代替。bash + git のみで完全再現。

### 提供スクリプト

| Script | 役割 | I/O |
|---|---|---|
| `_lib/scripts/worktree-create.sh` | 新規 worktree 作成 | in: `<issue-num> [base-ref]` / out: worktree absolute path |
| `_lib/scripts/worktree-finalize.sh` | 変更検知 + auto-cleanup or metadata 返却 | in: `<worktree-path> [base-ref]` / out: JSON `{changed: bool, ...}` |

### 使用フロー

```bash
# Phase 1: prepare
WT=$(bash _lib/scripts/worktree-create.sh 79 main)
# WT=/path/to/repo-worktrees/feature/issue-79

# Phase 2-7: do work inside $WT
( cd "$WT" && do_things )

# Phase 8: finalize
result=$(bash _lib/scripts/worktree-finalize.sh "$WT" main)
echo "$result" | jq .
# 変更なし: {"changed": false}                    (worktree 自動削除)
# 変更あり: {"changed": true, "path": "...", "branch": "feature/issue-79", "commit": "..."}
```

### Claude Code `isolation: worktree` との対応

| 機能 | Claude Code 内部 | portable bash 版 |
|---|---|---|
| empty worktree dir 作成 | daemon が `~/.claude/worktrees/agent-<uuid>/` を作る | `worktree-create.sh` で `<repo>-worktrees/feature/issue-N/` |
| branch checkout | worker が自分で `git checkout -b` | `worktree-create.sh` が `git worktree add -b` で同時 |
| 変更なし → cleanup | daemon 自動 | `worktree-finalize.sh` で明示 |
| 変更あり → retain + metadata | `Agent` tool に return value | JSON stdout |
| Nesting | 禁止 (subagent 内から subagent 不可) | **OK** (bash script はネスト可) |
| Lifecycle 制御 | implicit | explicit (debug 用に `--keep-worktree` 等を後付け可) |

**Nesting 可能** は orchestration 解体時に効く — 既存 `dev-kickoff-worker` 内では skill から
skill を呼べないが、bash script なら自由に組める。

### Regression test

`_lib/scripts/worktree-portable.bats` で create/finalize/cleanup の 7 ケース。

```bash
bats _lib/scripts/worktree-portable.bats
```

---

## 6. SKILL.md Frontmatter Portability

### 問題

本リポ自体の **75 個** の SKILL.md (`.agents/` 配下の外部 skill は除外、`lint-portable-frontmatter.sh`
基準) のうち **71% (53 個)** が Claude 拡張 frontmatter を使用。`.agents/` 配下も含めた
全 102 個では 56% で、外部 skill (Vercel skills.sh 由来等) は portable 寄りに書かれてる傾向。

Codex の strict YAML parser はこれらを **invalid 判定** して skill 自動 load 失敗。

実証: `pr-review/SKILL.md` を Codex で読み込み

```
ERROR codex_core::session: failed to load skill .../pr-review/SKILL.md:
  invalid YAML: did not find expected key at line 5 column 28
```

### 影響範囲 (`lint-portable-frontmatter.sh` 直近結果 / 本リポのみ 75 個)

| Field | 使用 skill 数 | % | Risk | 移行先 |
|---|---|---|---|---|
| `model` | 39 | 52% | Medium | adapter overlay or `metadata` |
| `effort` | 24 | 32% | Medium | adapter overlay |
| `allowed-tools` | 23 | 31% | **High** | AGENTS.md or adapter overlay |
| `context` | 21 | 28% | **High** | bash 別 process で代替 |
| `user-invocable` | 11 | 15% | **High** | adapter overlay |
| `argument-hint` | 2 | 3% | Low | そのまま (semantic 失われるが parse は通る) |
| `agent`, `hooks`, `disable-model-invocation`, `arguments`, `paths`, `shell` | 0 | 0% | — | スコープ外 (未実装) |

> Phase C 段階移行中。最新数字は `bash _lib/scripts/lint-portable-frontmatter.sh --root . --json` で取得。

### Portable subset (SKILL.md open standard)

これだけ書いて、それ以外は adapter overlay に分離する:

```yaml
---
name: dev-plan-review
description: |
  Critically review implementation plan as independent agent.
version: 1.0.0
author: it-all-playpark
tags:
  - dev-flow
  - review
agents:
  - claude
  - codex
  - antigravity
---

# Skill body (markdown) — portable
```

詳細設計は [#103](https://github.com/it-all-playpark/skills/issues/103) の Phase B で。
**新規 skill 作成時の規約・全 20 field の portable/非 portable 分類** は
[`docs/skill-creation-guide.md` § Portable subset と Claude Code 拡張](../../docs/skill-creation-guide.md)
を参照 (PR #104 で改訂)。

### Adapter overlay (reference 実装, issue #106)

Claude Code 拡張 frontmatter を portable SKILL.md から分離し、build script で merge する仕組み。
[`dev-plan-review`](../../dev-plan-review/SKILL.md) が **最初の reference 実装** (#103 Phase C)。

```
<skill-name>/
├── SKILL.md                 # portable subset のみ (cross-agent で parse 可能)
├── adapters/
│   └── claude.yaml          # Claude Code 拡張 (model / effort / context / allowed-tools)
└── ...                      # references/, scripts/ など既存構造
        │
        ▼
[ _lib/scripts/build-skill-overlay.sh dev-plan-review ]
        │
        ▼
$HOME/.cache/claude-skill-build/dev-plan-review/SKILL.md   ← Claude Code が読む merge artifact
                                                           ← Codex CLI / agy は元の portable SKILL.md を直接読む
```

設計判断 (issue #106 推奨採用):

| # | 判断 | 採用案 |
|---|------|--------|
| Q1 | adapter overlay の置き場所 | A: `<skill>/adapters/<vendor>.yaml` |
| Q2 | Claude への merge 方法 | 1: build script artifact (runtime merge 不要) |
| Q3 | artifact の git 管理 | Y: git ignore + CI/hook で再生成 |
| Q4 | Claude Code subagent (`context: fork`) | A: build artifact に merge して既存挙動維持 |

merge ルールと CLI 詳細は [`docs/skill-creation-guide.md` § Adapter Overlay 規約](../../docs/skill-creation-guide.md)
を参照。

実装ファイル:
- `_lib/scripts/build-skill-overlay.sh` — bash entry point (frontmatter 抽出 / atomic write)
- `_lib/scripts/yaml-merge.py` — PyYAML 6.x ベースの薄い merge helper (overlay-wins + block scalar 保持)
- `_lib/scripts/build-skill-overlay.bats` — 単体テスト 7 ケース
- `dev-plan-review/adapters/claude.yaml` — Claude Code 拡張 4 field の reference

残り 52 skill (本 PR で 53→52) の移行は別 issue で機械的に進める。

### Lint and Audit scripts

#### Invariant lint (PR #104 で追加、CI 連携前提)

```bash
# JSON で現状確認 (本リポのみ 75 個 scan、.agents/ 除外)
bash _lib/scripts/lint-portable-frontmatter.sh --root . --json

# 拡張 field が 1 つでも残っていれば fail (将来 CI で有効化予定)
bash _lib/scripts/lint-portable-frontmatter.sh --root . --strict
```

#### Detailed audit report (本リポ + 外部 skill 102 個)

```bash
bash _lib/scripts/audit-skill-portability.sh
# 出力: claudedocs/skill-portability-audit-<date>.md (skill 一覧 + risk 分類付き)
```

使い分け:
- **lint**: CI / pre-commit hook で「拡張 field が増えてないか」regression check
- **audit**: 詳細レポート (skill ごとの使用 field 一覧、Phase A の影響範囲調査)

---

## 7. Failure Modes

### Claude Code state 遷移 (smoke test 確認済)

```
spawn → working ─┬─→ done     正常完了。timeline.jsonl 最終行に raw text
                 ├─→ blocked  skill が input 待ち (引数不足、interactive 要求等)
                 ├─→ stopped  claude stop による中断、timeline.jsonl 作られず
                 └─→ failed   未確認 ⚠️ TODO
```

判定:

```bash
state=$(jq -r '.state' ~/.claude/jobs/$id/state.json)
detail=$(jq -r '.detail' ~/.claude/jobs/$id/state.json)
case "$state" in
  done)    ;; # 正常完了
  blocked) echo "input needed: $detail" >&2 ;;
  stopped) echo "interrupted" >&2 ;;
  failed)  echo "error: $detail" >&2 ;;
esac
```

### Codex CLI

- exit code 非 0 で error 判定
- progress を stderr (`thread.started`, `turn.started`, ...) で stream
- `--output-last-message <file>` が empty なら failure と判定可能

### Antigravity (agy)

- exit code 非 0 で error 判定
- timeout は `agy --print-timeout` (default 5min) で制御、超過時 exit ≠ 0

### Subagent 制限

- Claude Code: `isolation: worktree` 内では nested subagent 不可 (public docs L737)
- Codex: 確認未済
- agy: 確認未済

bash coordinator 経由なら **どの agent でも nesting 制限なし** (別 process)。

---

## 8. Migration Path

既存 `dev-flow` / `dev-kickoff` を段階的に portable harness に移行する手順。

### Stage 1: 基盤整備 (ほぼ完了)

- [x] AGENTS.md 移行 ([#101](https://github.com/it-all-playpark/skills/issues/101))
- [x] SKILL.md portable subset 化 — Phase A/B 基盤整備 ([PR #104](https://github.com/it-all-playpark/skills/pull/104) merge 済)
  - `lint-portable-frontmatter.sh` 追加 (CI 連携前提)
  - `docs/skill-creation-guide.md` に portability 規約セクション追加
- [x] SKILL.md portable subset 化 — Phase C reference 実装 (`dev-plan-review` + `build-skill-overlay.sh`、issue #106)
- [ ] SKILL.md portable subset 化 — Phase C: 残り 52 skill の段階移行 (本 PR で 53→52)
- [x] portable adapter PoC (`invoke-skill-poc.sh`)
- [x] worktree adapter (`worktree-create.sh` + `worktree-finalize.sh`)
- [x] SKILL.md audit / lint script

### Stage 2: Decision script + state machine (Issue #108 で実装)

- [x] `_lib/schemas/flow.schema.json` v2.0.0 → **v2.1.0 bump** + 新規 `phases[]` (5 値固定 enum / required + minItems 5 / additionalProperties false)
- [x] `_lib/schemas/decision-input.schema.json` 新規 (5 phase ごとの `oneOf` envelope、`phase` discriminator)
- [x] `_lib/scripts/flow-decide.sh` 新規 (decision script — read-only、phase 状態と result を受けて `next_action: skill | complete | abort | retry` を JSON で返す)
- [x] `_lib/scripts/flow-update.sh` に `phase <name> <status> [--retry-target] [--score] [--attempts +1]` action 追加 + `write_flow` を `flock -x` 化 (Python fcntl fallback あり)
- [x] `dev-decompose/scripts/init-flow-v2.sh` で 5 phase を `status: pending` で seed
- [x] tests:
  - `tests/flow-schema-v2-validate.sh` (Case 1-9 / 新 Case 7 phase.additionalProperties / 8 name.enum / 9 phases.minItems==maxItems==5)
  - `tests/flow-v2-version-bump.sh` (invariant: schema/scripts/tests に旧 `"2.0.0"` 残骸が無いこと)
  - `tests/flow-update-phase-action.sh` (T1-T8: phase action 7 ケース + parallel race)
  - `tests/flow-decide-cases.sh` (AC3.1-3.19: 各 phase 遷移 + retry + abort + dry-run 5-phase integration)
  - `tests/validate-decomposition-v2-branch.sh` (fixture を v2.1.0 + phases[] に更新)
- 役割分離: **flow.json (top-level orchestration phases[]) = child-split mode のみ / kickoff.json (single mode phase 内遷移) は version bump 波及させない**
- 並行 writer 制御: `flow-update.sh write_flow` 内で `flock -x <flow>.lock` (flock 不在環境は Python fcntl で fallback)
- iterate.schema.json と decision-input.schema.json の pr_iterate envelope は整合 (`lgtm | max_reached | failed` = iterate.status enum から `in_progress` を除外)
- 2 階層 phases モデル:
  - `flow.json.phases[]` = top-level orchestration (decompose / batch_loop / integrate / final_pr / pr_iterate)
  - `kickoff.json.current_phase` = single mode の child 内 phase (1b → 8、`dev-kickoff/scripts/next-action.sh` の管轄、本 PR では変更しない)

### Stage 3: Orchestrator skill の薄化

- [ ] `dev-flow/SKILL.md` を「bash decision script + invoke-skill-poc.sh のループ」に書き換え
- [ ] `dev-kickoff/SKILL.md` 同様
- [ ] 既存 `dev-kickoff-worker` (`isolation: worktree`) は **Claude Code 用 adapter として残す** (後方互換)
- [ ] 他 agent (Codex/agy) 用に `_lib/runners/codex-runner.sh`, `agy-runner.sh` を追加

### Stage 4: 検証

- [ ] 1 issue を 3 agent で完走 (single mode)
- [ ] child-split mode で 1 親 issue を 3 child に分解 → 3 agent で個別完走
- [ ] dev-flow-doctor で前後比較 (turns, duration, retry count)
- [ ] 失敗時の振る舞い検証 (各 phase failure → 戻り先分岐)

### Stage 5: 周辺整理

- [ ] `pr-review`, `pr-iterate`, `pr-fix` を同パターンに
- [ ] `dev-implement` の Red-Green-Refactor 分解検討 (任意)
- [ ] Cursor / Amp の smoke test と adapter 追加 (任意)

---

## 9. Open Questions / TODO

実装または運用フェーズで埋めるべき空白。

| # | 項目 | 影響 | 優先度 |
|---|---|---|---|
| 1 | Claude Code `state: "failed"` の具体的発生条件 | failure handling の精度 | Low |
| 2 | Codex CLI の subagent 機構 (`.codex/agents/*` 相当の有無) | subagent portable 化 | Medium |
| 3 | Antigravity (agy) の subagent 機構 (plugin との関係) | subagent portable 化 | Medium |
| 4 | Cursor / Amp の smoke test (install 未済) | 対応 agent 拡張 | Low |
| 5 | `--bg --agent <name>` で ad-hoc subagent (`--agents` inline JSON) を動かす方法 | 動的 subagent 構築 | Low |
| 6 | AGENTS.md の階層継承 (subdirectory 別 AGENTS.md) の必要性 | 規約スコープ管理 | Low |
| 7 | Codex の SKILL.md auto-discovery を skip するモード (`--sandbox read-only` で skip される根拠の確認) | trouble shooting | Medium |
| 8 | Background session の cleanup 戦略 (古い `~/.claude/jobs/<id>/` の自動削除) | 運用ハイジーン | Low |

---

## 10. References

### 外部ソース

- [Harness Engineering for Coding Agents — Birgitta Böckeler, Thoughtworks (2026-04-02)](https://martinfowler.com/articles/harness-engineering.html)
- [How coding agents work — Simon Willison (2026-03-16)](https://simonwillison.net/guides/agentic-engineering-patterns/how-coding-agents-work/)
- [How to build a coding agent — Geoffrey Huntley](https://ghuntley.com/agent/)
- [AGENTS.md open standard (Linux Foundation AAIF, 2025-12 寄贈)](https://agents.md)
- [SKILL.md open standard](https://www.agensi.io/learn/skill-md-specification-open-standard)
- [Vercel skills.sh](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)

### CLI 公式 docs

- [Claude Code: Run programmatically (`-p`, headless)](https://code.claude.com/docs/en/headless)
- [Codex CLI: Non-interactive mode (`codex exec`)](https://developers.openai.com/codex/noninteractive)
- [Antigravity CLI: Getting started](https://antigravity.google/docs/cli-getting-started)

### 本リポ内

- [`docs/skill-creation-guide.md`](../../docs/skill-creation-guide.md) §
  Portable subset と Claude Code 拡張 — 新規 skill 作成時の規約 (PR #104 で追加)
- `_lib/scripts/lint-portable-frontmatter.sh` — invariant lint (CI 連携前提、本リポ 75 個 scan)
- `_lib/scripts/audit-skill-portability.sh` — 詳細 audit (`.agents/` 含む 102 個 scan、レポート生成)
- `_lib/scripts/invoke-skill-poc.sh` — portable adapter PoC (claude/codex/agy)
- `_lib/scripts/worktree-create.sh` / `worktree-finalize.sh` — worktree adapter
- `claudedocs/skill-portability-audit-*.md` — 直近の audit レポート
- [#101](https://github.com/it-all-playpark/skills/issues/101): AGENTS.md 移行 (merged)
- [#103](https://github.com/it-all-playpark/skills/issues/103): SKILL.md portable subset 化 (Phase A/B 基盤整備 PR #104 merged)

---

_Last updated: 2026-05-22 (Stage 2 実装完了 — issue #108)_
