---
description: dev-flow / pr-iterate / dev-improve の不変条件（fail-closed の理由・sunset トリガ・起動形の制約）。詳細は plugins/dev-flow/dev-flow/references/
paths:
  - "plugins/dev-flow/.claude/workflows/**"
  - "plugins/dev-flow/agents/**"
  - "plugins/dev-flow/.claude/agents/**"
  - "plugins/dev-flow/_lib/**"
  - "plugins/dev-flow/_shared/**"
  - "plugins/dev-flow/dev-flow/**"
  - "plugins/dev-flow/dev-flow-doctor/**"
  - "plugins/dev-flow/dev-flow-improve/**"
  - "tools/**"
---

# dev-flow 不変条件

dev-flow 本体（workflow / agent 定義 / `_lib` canonical / generator）を触るときだけ読み込まれる。
不変条件・fail-closed の理由・sunset トリガ・起動形の制約のみを置く。詳細は
`plugins/dev-flow/dev-flow/references/`:

- `pipeline.md` — phase 経路 / shape 3 tier / lite route / subagent の model・effort・fallback / isolation probe / gate_policy・block_class
- `telemetry.md` — telemetry キー一覧と Stop hook の二経路転送
- `justification-classes.md` — W7 distrust 正当化クラス・prescription 正当化クラスと sunset path
- `exec-proxy.md` — bin/ bare 名起動形・check-ci の argv 転写・失敗ポリシー表
- `inline-generation.md` — sync-inlines の起動形と canonical の構造制約
- `dev-improve.md` — 自己改善ループの設計

## 構造

- Claude 専用（workflow 依存）。cross-vendor 放棄は dev-flow / pr-iterate のみ（本ファイルを AGENTS.md から分離する理由）
- skill wrapper が isolation preflight → `Workflow({ name: 'dev-flow:dev-flow-run' })`。orchestration と中間 state は workflow script の JS 変数のみ（外部 state JSON なし）
- `meta.name` は `dev-flow-run` でも telemetry handoff の `skill` は `'dev-flow'` 固定（集計連続性）
- `/pr-iterate` の Workflow 名は `dev-flow:pr-iterate`（bare 名フォールバック無し）
- `agent()` の agentType は `nsAgentOpts()` でのみ namespace 付与（bare 名は起動直後 abort）。routing test は論理名（bare）を保持。dev-flow-canary.js のみ namespaced id 直書き
- 1 issue = 1 PR。Implement は全 shape で `dev-implement-fable`（plan+impl 統合）を単一 worktree に 1 spawn（Plan phase なし。planner ⇄ reviewer ループ・parallel fan-out・`pipeline()` は持たない）。BLOCKED 再実装・green-fix（`model: 'sonnet'`）・Evaluate 差し戻しも同じ agent。複数 issue 分割は使わない
- model 既定は frontmatter。override は `dev-implement-fable` の green-fix（`model: 'sonnet'`）のみ。品質ゲート agent には渡さない — gate の判定モデルを credit で黙って変えない
- merge は常に人間（全 tier）
- 後方互換 scaffolding を作らない — out-of-enum は明示 error
- worktree の後片付けは `worktree-teardown`（`git worktree remove` 直打ちは veridelta 証跡を失う）

## ゲート（fail-closed / fail-safe の理由）

- 軸A invariant: deterministic oracle / seed / critical は全 gate_policy で blocking。security floor と決定論ゲートを policy で緩めない。記録専用 telemetry は gate 入力にしない
- Merge tier は pr-iterate の後（fix 後の最終 tree で danger 再 reconcile）。fixes_applied>0 は Final reconcile で test 再実行、red / 再検証不能は HOLD（PR head sha に pin した CI 決定論判定でのみ代替）
- danger-grep 失敗は fail-closed（全 SEC seed unchecked → HOLD）。realized-diff / redgreen / final-reconcile / final-ac-reconcile / issue-labels の失敗は fail-safe（安全側 floor・HOLD）。advisory 信号（ui-verify / ci-checks / structural / vdelta / post-comment / clock / pr-meta）は fail-open。理由: 決定論 gate の入力不明を通過と同一視しない
- analyze ゲート（Setup 末尾）は prerun の決定論 analyze（`analyze-issue --contract` + Jev）の検証とゲートのみで通常経路の spawn は 0。LLM に issue を転写させる経路を戻さない（転写者がいれば provenance 突合が要る）。AC 空 / comment_conflicts 非空 / uncertain 非空は needs_clarification で終端（決定論は意味的矛盾の要否を判定できず、LLM に黙って片方を採らせると訂正が実装に反映されない）
- empty-diff gate は fail-closed（cross-repo は人間ラベル opt-in + 決定論 dirty 検証が揃った場合のみ graceful 終端）
- block_class は `approach_mismatch` / `guard_blocked` の閉じた enum。guard_blocked は replan ループから除外し evaluator focus へ直行
- isolation probe: `written:false` は fail-closed（throw + 回避手順: 別 worktree を add → EnterWorktree → 再実行）。probe 自体の失敗は fail-open。`bgIsolation:"none"` による guard 無効化は採らない（共有 checkout 汚染は blast-radius。設定緩和で sunset しない）
- Stop hook の per-key flag を新設したら `PER_KEY_TELEMETRY_KEYS` にも足す（passthrough 側が drop 済みの契約違反値を復活させ fail-closed が迂回されるため）。新規キーは handoff に載せるだけで到達する

## distrust / prescription の正当化（sunset トリガ）

- 各 distrust 機構は incentive-structural（永続）/ blast-radius（永続）/ capability-bound（sunset 対象）を宣言。capability-bound はパラメータ値 + 再評価トリガを併記。クラス無しは負債
- agent への指示も contract / incentive-structural / capability-bound を宣言。capability-bound の再評価は major モデルリリース毎の dry-run
- sunset トリガ: `gate_policy` → calibration monitor が judge を well-calibrated と実証した時点で blocking へ。pr-iterate major 閾値 → 同（critical は永続）。ui-verify advisory → UI judge precision 実証まで固定。redgreen vdelta → deny-only 固定、record_integrity 昇格 + precision 実証で再評価。trust-layer 復帰 → (1) 監査証跡の破壊的上書き無し (2) classifier ブロックが run abort へ波及しない実測 (3) 完走率が劣後しない、の 3 条件を満たす再設計のみ
- incentive-structural / blast-radius はモデル更新で撤去しない

## exec-proxy（起動形の制約）

- script は plugin `bin/` の bare 名を**先頭トークン**にする。絶対パス・`bash`/`cd`/env 前置は書かない（sandbox excludedCommands は先頭トークン一致。dotfiles 側と対で運用、片側だけ変えると止まる）
- plugin の `bin/` PATH はセッション起動時に version 込みで焼かれる — update 後は新セッションで `command -v` 確認。素のシェルでは常に失敗（欠陥ではない）

> exec-proxy スクリプトは認証付き network I/O（gh・git push）を内部に持ってはならない（唯一の例外:
> `analyze-issue` は issue 取得の bare `gh issue view` を内蔵し stdout を in-process で受ける。呼び出し元は
> subagent ではなく prerun（`dev-flow-prerun` → `prerun-analyze.sh`）で、Jev もそこから呼ぶ —
> subagent の sandbox 内では資格情報に届かない）。GitHub I/O は
> subagent の Bash で「先頭トークンが gh または git の bare 単文」（gh は --repo、git は -C 不可、
> cd &&・bash・env 前置禁止）として実行し、出力を $TMPDIR の file に落とすか、呼び出し側 agent が
> stdout/stderr を argv でスクリプトへ verbatim 転写して、スクリプトは file または argv 入力の
> 純変換とする。prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない —
> exec-proxy prompt は決定論スクリプトへの verbatim 転写契約であり、起動形の正しさは
> excludedCommands という設定側の不変条件である。設定の正当化は本ファイルと AGENTS.md の一箇所に置き、
> per-prompt で再説明しない（prompt 内の再説明は転写契約に判断余地を持ち込み、下流の prompt へ
> 引用・増幅される）。**例外はない**。wall-clock polling も同じで、fetch は
> exec-proxy の 1 spawn = 1 判定（`ci-check`）、sleep は workflow script 側のループが別 exec-proxy
> （`ci-wait <秒>` の bare 単文。Bash tool が数秒超の bare `sleep` を拒否するため、内部で短い sleep を
> チェーンする専用 script を挟む）で行い、スクリプトは snapshot 1 枚に対する純変換に保つ
> （`check-ci` が precedent）。
>
> polling ループを subagent 内に置いてはならない（turn 会計が CI 所要時間に連動し、StructuredOutput
> 未達で `ci_error` に化ける）。ループは workflow script 側に置き、総待機上限は
> `CI_WAIT_CEILING_SECONDS`（`_lib/ci-check.mjs`）で持つ。1 spawn の必要 turn（ci-check:
> 2 + 1 + CI_TURN_MARGIN、ci-wait: 1 + 1 + CI_TURN_MARGIN）が当該 agent の `maxTurns` を超えないこと

- exec-proxy と inline generator は harness-capability-bound な橋。再評価トリガ: harness が直接 exec / ESM import を解禁した時点で撤去（`/dev-flow-canary` → `run-diagnostics --canary`）

## inline 生成区間

- `// ==== BEGIN inline:` 〜 `END inline` は生成物で直接編集禁止。`_lib` canonical を直し `tools/sync-inlines.mjs --write`（先頭トークン=スクリプトパスの bare 形、node/cd/bash 前置なし）。新規区間は `--add <_lib/x.mjs> --into <workflow.js> --after '<一意な行>'`
- canonical 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。ファイル全体が inline 可能
- git plumbing による guard 迂回禁止（手編集が次回 --write で黙って消える事故防止）。plugin disable で edit/commit 両 guard が同時に失われる

## dev-improve

- state は GitHub issue のみ（label self-improve / self-improve-backlog）。外部 state JSON なし
- IMPROVE_MAX=2/サイクル。open 数取得失敗は fail-closed（skip）。not_confirmed は revert 候補、自動 revert なし
