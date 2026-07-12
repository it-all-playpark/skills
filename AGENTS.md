# Project overview

Skills Repository — Claude Code Skills のモノレポ。cross-vendor の coding agent
(Claude Code / Codex CLI / Cursor / Aider / Amp / Gemini CLI / GitHub Copilot /
Devin / Jules / Zed / Continue / Roo Code / Factory Droids / Windsurf / Amazon Q)
で共通の project context を提供する。

This file follows the [agents.md](https://agents.md) standard (Linux Foundation AAIF, 2025-12).
Subdirectory `AGENTS.md` files take precedence over this root file for their respective paths.

## Setup commands

```bash
# bats (テストフレームワーク) のインストール
brew install bats-core        # macOS
apt-get install bats          # Ubuntu / Debian

# テスト実行
bash tests/run-all-bats.sh           # ローカル開発 (bats 未インストール時は graceful skip)
bash tests/run-all-bats.sh --strict  # CI 用 (bats 未インストールを error 扱い)
```

ディレクトリ構造:

```
skills/
├── skill-name/           # 各スキル
│   ├── SKILL.md          # Frontmatter + ワークフロー
│   ├── scripts/          # 決定論的処理
│   └── references/       # 詳細ドキュメント
├── _shared/              # 共有リソース (references, scripts)
├── _lib/                 # 共有ライブラリ (common.sh, config.py)
├── .agents/skills/       # 外部スキル (symlink)
├── skill-config.json     # スキル固有設定 (ツール非依存)
├── .claude/              # Claude Code 固有設定
└── docs/                 # プロジェクトドキュメント
```

新規スキル作成は `/skill-creator` を使用。共有処理は `_shared/` か `_lib/` に配置。

## Code style

- **SKILL.md の description は簡潔に** — 常にコンテキスト消費される (15,000 文字 budget)
- **決定論的処理はスクリプトに抽出** — ファイル検索・JSON操作・git操作・API呼び出し
- **Progressive Disclosure** — SKILL.md は概要、詳細は `references/` に分離
- **Namespace 命名** — `dev-*`, `blog-*`, `git-*`, `sns-*` 等でグループ化
- **既存パターンに従う** — 新規スキルは同カテゴリの既存スキルを参考にする
- **共有処理は `_shared/` か `_lib/`** — スキル間で重複するロジックは共有化
- **後方互換 scaffolding を作らない** — schema 変更で legacy fallback / version enum / dual-path を入れない。新形式のみ受理

SKILL.md description は third-person 命令形で書く (`Extracts ...`, `Converts ...`)。
`Use when:` には具体トリガ語を列挙する。`"I"` / `"this skill"` 等の一人称は禁止。
控えめに書くと Claude が呼ばない — push 気味に書く。

## Testing instructions

決定論的スクリプトには bats (`*.bats`) でユニットテストを書く。テストファイルは実装スクリプトの隣に配置:

```
skill-name/scripts/foo.sh      # 実装
skill-name/scripts/foo.bats    # テスト (隣接配置)
```

実行:

```bash
bats skill-name/scripts/foo.bats          # 単体
bash tests/run-all-bats.sh               # 全 bats 一括
bash tests/run-all-bats.sh --strict      # CI 用 (bats なしを error 扱い)
```

bats が見つからない環境でも `tests/run-all-bats.sh` は exit 0 を返すため、
ローカル開発を阻害しない。CI からは `--strict` を渡して bats のインストール漏れを検出する。

## Architectural guardrails

### dev-flow (dynamic workflow)

`dev-flow` は Claude Code の **dynamic workflow** (`.claude/workflows/dev-flow.js`) として実装する。
orchestration (phase 遷移 / plan-review・evaluate・pr-iterate の各ループ / 並列実装の fan-out) は
workflow script が JS で保持し、中間 state は script 変数に持つ (外部 state JSON は持たない)。

```
/dev-flow <issue>   → Setup → Analyze(shape 判定) → Plan
                      → Implement(serial/parallel) → Validate(test green)
                      → Evaluate → PR → workflow('pr-iterate')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → review ⇄ fix loop (LGTM まで, 上限10)。単体起動可
```

Merge tier を pr-iterate の後に置くのは、fix 適用後の最終 tree に対して danger-grep 再実行・danger 再 reconcile を行い、merge 判定を最新の PR 内容に基づかせるため。pr-iterate が fix を適用した run では Final reconcile phase が worktree を PR 最終 HEAD へ同期し test suite を一発再実行する（red / 再検証不能は merge tier HOLD。fixes_applied=0 は agent 呼び出しゼロで skip）。

shape ごとの経路（3 tier）:

| shape | Plan 経路 | Evaluate 経路 | merge tier |
|-------|-----------|---------------|------------|
| **micro** | plan 1 発・plan-reviewer 0 回（triviality gate で review loop skip） | skip（evaluator 0 回）。ただし danger-grep hit 時は security path で強制実行 | docs・test-only + danger clean + 収束なら AUTO 推奨ラベル（merge は人間） |
| **standard** | plan 1 発・plan-reviewer 0 回 | 1 パスのみ（差し戻しなし。未解消 critical は merge tier HOLD + human review で担保） | REVIEW |
| **complex** | dev-planner ⇄ plan-reviewer の review loop（上限 PLAN_MAX=8、topic-stuck 検出で early-cutoff あり） | 差し戻し loop（上限 EVAL_MAX=10） | REVIEW、danger・breaking で HOLD |

shape は Analyze phase で `classifyShape` が判定し、安全 floor を適用する（`estimated_change_file_count` 欠落・`acceptance_criteria` 欠落・out-of-enum `issue_type`・breaking 検出 → complex floor）。実装後は realized diff のファイル数で `refloorShape` が再判定（EFFECTIVE_SHAPE、raise-only）。danger-grep hit があれば micro でも Evaluate を強制実行（security path）。

- **判断系 leaf は subagent** (`.claude/agents/{dev-planner,plan-reviewer,implementer,evaluator,pr-reviewer,dev-runner,dev-runner-haiku,dev-runner-haiku-ro}.md`)。
  workflow の `agent()` には effort 引数が無いため、effort は subagent frontmatter で固定する。
  model は frontmatter を既定としつつ `agent()` の `opts.model` で per-call override できる —
  品質ゲート系 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer、frontmatter 既定 opus）は
  `_lib/quality-model.mjs` の `QUALITY_MODEL` 定数で一括指定する（tools/sync-inlines.mjs で
  dev-flow.js / pr-iterate.js へ inline 生成。現在 `fable` 試験運用中。戻すときは
  `_lib/quality-model.mjs` の 1 行を `'opus'` に変更し `node tools/sync-inlines.mjs --write` を実行）。
  model を恒久的に別系統へ固定したい leaf には専用 agent 定義
  （例: `dev-runner-haiku.md`、`model: haiku`）を用意し `agentType` を切り替える。
  品質ゲート系 4 agent は `effort: high`
  （A/B 実測で max と精度同等・約21%高速）、implementer / dev-runner は `effort: high`、
  dev-runner-haiku / dev-runner-haiku-ro は `effort: low`（issue #323 の A/B 実測 —
  claudedocs/2026-07-12-issue-323-exec-proxy-effort-ab.md。mechanical exec-proxy は
  low が high に schema 成功率で劣後しないことを実測）。
- **1 issue = 1 PR**。並列実装は単一 worktree 内で file-disjoint な task を `parallel()` で fan-out する
  (旧 child-split / DAG / integration branch / batch loop は廃止)。
- **merge は手動** (LGTM 後にユーザーが merge)。
- Claude 専用 (workflow 依存)。cross-vendor portability は dev-flow / pr-iterate のみ放棄する例外扱い。
- **gate_policy**: trust 昇順の 4 値 enum — `deterministic-only` / `llm-major-advisory`（既定）/ `llm-major-blocking` / `llm-autonomous`。
  **軸A invariant 不変** — deterministic oracle / seed / critical アイテムは全 policy で blocking のまま（security floor / 決定論ゲートは policy で緩めない）。
  **既定同一挙動** — 既定 `llm-major-advisory` は軸A invariant（critical / deterministic / seed = blocking）+ LLM major/minor = advisory の既定 lane 分類と全アイテムで一致し、非 default policy のみ gating が変わる（enum で境界を滑らせる設計）。
  out-of-enum 値は明示 error（legacy fallback / version 分岐なし）。canonical は `_lib/gate-policy.mjs`、dev-flow.js への inline は tools/sync-inlines.mjs で生成・`_lib/workflow-inlines.sync.test.mjs` が全文一致保証。
- **telemetry**: dev-flow 完走時に workflow が telemetry handoff JSON（merge_tier / gate_policy / danger_hits / shape /
  shape_refloored / plan_iter / eval_iter / eval_staleness / eval_verdict / iterate_status / ui_verify / ui_verify_mode /
  final_reconcile / final_test_green / final_ui_verify / final_ac_reconcile）を
  `~/.claude/journal/pending/` へ書き出し、
  dotfiles の Stop hook `claude-code/hooks/stop-devflow-telemetry.sh` が `journal.sh log dev-flow success --merge-tier ...`
  へ毎回自動 flush する（issue #203）。flush 失敗は `~/.claude/logs/stop-devflow-telemetry.log` に記録され pending file が
  残るため記録漏れに気づける。journal.sh の telemetry フラグは未指定なら telemetry キー無し。calibration の原資料。
  `ui_verify` は `skipped`/`passed`/`findings`/`failed_open`/`setup_failed` の 5 値（`setup_failed` は dev-flow-doctor の検出対象）。
  `eval_staleness` は `none`/`hash_mismatch`/`iterate_incomplete`/`iterate_fixed` の 4 値（Evaluate 時点と PR tree の乖離原因を区別する。issue #288）。
  `final_reconcile` は `skipped`/`reverified`/`unavailable` の 3 値（fixes_applied=0 は `skipped`、worktree 同期・test 再実行に成功したら `reverified`、同期失敗・schema 不一致等は `unavailable`）。
  `final_ac_reconcile` は `skipped`/`reverified`/`unavailable` の 3 値（fix 適用 run で final test が green/no_tests かつ AC が 1 件以上のときのみ targeted evaluator を one-shot 起動して Analyze 時点の既存 AC を最終 PR tree に対し再検証する。index 完全性・evidence 非空の決定論検証に合格すれば `reverified`、agent null・schema/index/evidence 検証不合格は `unavailable` → merge tier HOLD。未実行は `skipped`）。
  `final_test_green` は final test 実行時のみ出力（Final reconcile が `reverified` の場合のみ）。
  `final_ui_verify` は final UI 再検証実行時のみ出力（`ui_verify` と同語彙: `skipped`/`passed`/`findings`/`failed_open`/`setup_failed`）。
  earned-autonomy 集計・calibration は **W6b へ繰り延べ**（W6 は enum 骨格と telemetry 蓄積開始のみ）。

#### distrust 機構の正当化クラス (W7)

dev-flow の各「distrust 機構」（LLM/自動化の判定を信用しきらず決定論・人間で gate する仕組み）は、
以下 **3 つの正当化クラスのいずれか**に必ず分類する。**正当化クラスと sunset path の無い distrust
機構は定義上「将来の技術的負債」**（モデルが賢くなっても撤去判断ができず過小活用が累積する）。
新しい distrust を足すときは必ずクラスを宣言し、capability-bound なら sunset path
（パラメータ値での表現 + 再評価トリガ）を併記すること。詳細は
`claudedocs/2026-06-09-dev-flow-adaptive-ledger-redesign.md` §2（2 軸）/ §4.5 / §6。

| クラス | 正当化根拠 | 能力依存 | 代表機構 |
|--------|-----------|---------|---------|
| **incentive-structural**（永続・撤去禁止） | 敵対ループの勝利宣言を当事者に self-judge させない incentive 設計 + cold-context moving-target の抑制 | **非依存**（賢いモデルほどシャープな non-convergent nitpick を出すため逆に悪化） | frozen target（planSeen/evalSeen/blockSeen 累積）・既出 findings/feedback 累積・topic-stuck 検出 + relax + early-cutoff・critical-always-blocks + severity floor + append 単調性・hard cap（PLAN/EVAL/GREEN/BLOCK_MAX, last-resort safety net）|
| **blast-radius**（永続） | 不可逆性 / accountability / liability / blast-radius。正確性ではなく当事者性で正当化するため frontier が人間を超えても残る | **非依存** | human merge（accountability/不可逆/values/novelty）・danger-grep on realized diff → security path 強制・seeded SEC + merge tiering HOLD（danger/breaking/不可逆）・pr-iterate critical/major-always-blocks（merge 直前の最終ゲート: この先は human merge のみで、ここで relax すると既知の critical/major が出荷される。修正コストは PR スコープに bounded）・Final reconcile（pr-iterate fix 適用後の最終 tree に対する決定論 test 再実行 + 既存 AC の one-shot 再検証（fail は critical AC-FINAL append・既存 checked は不変の append 単調） → red/unavailable で HOLD。merge 直前の最終ゲート）|
| **capability-bound**（**sunset 対象**） | 現行 LLM judge の信頼性不足（ECE≈39% / FPR≈35%）。モデルが賢くなるほど縮む | **依存** | `gate_policy = llm-major-advisory`（LLM major を blocking にしない distrust）・ui-verify advisory 固定（UI 判定を blocking にしない distrust）|

**capability-bound の sunset path（必須）**: パラメータ値で表現し再評価トリガを持たせる。
`gate_policy` の sunset path —
- 表現: `gate_policy` enum 値（`llm-major-advisory` → `llm-major-blocking`）。
- 再評価トリガ: **major モデルリリース毎** + W6b の calibration monitor が当該カテゴリの
  judge を well-calibrated と実証した時点。実証されたら `gate_policy` を LLM 側（blocking）へ進める。
pr-iterate major 閾値の sunset path —
- pr-iterate の critical/major-always-blocks は主分類 blast-radius（永続）だが、**major 閾値**（pr-reviewer の major 判定を blocking に含める線引き）は LLM judge の信頼性に**能力依存**する capability-bound 側面を持つ。critical-always-blocks 部分は永続で sunset しない。
- 表現: 将来 pr-iterate の major blocking 判定を `gate_policy` 連動（`llm-major-advisory` 系の値で major を advisory 化）にする形で表現する — 現在は policy 非連動の固定値（critical/major 常時 blocking）。
- 再評価トリガ: W6b の calibration monitor が pr-reviewer の major judge を well-calibrated と実証した時点で `gate_policy` 連動へ移行する。実証まではゲート後退（relax）させない。
ui-verify advisory 固定の sunset path —
- 表現: ui-verify findings は UI-* ledger item（inspection / major = 既定 gate_policy で advisory lane）として固定。blocking にしない。
- 再評価トリガ: telemetry `ui_verify` / `ui_verify_mode` を W6b の calibration monitor で pr-reviewer / human verdict と突合し、UI judge の precision が実証された時点で gate_policy 連動の blocking へ昇格する。実証まで advisory 固定。
- 逆に incentive-structural / blast-radius はモデル更新で撤去してはならない（§6 軸A 保持）。

#### inline 生成区間（_lib → workflows の sync generator）

`.claude/workflows/*.js` 内の `// ==== BEGIN inline: <path> ... ====` 〜 `// ==== END inline: <path> ====`
区間は**生成物であり直接編集禁止**。編集は `_lib` の canonical 側で行い `node tools/sync-inlines.mjs --write`
で再生成する（`--check` が CI で全文一致を検証 — `_lib/workflow-inlines.sync.test.mjs`）。blame は `_lib` 側を見る。

**canonical の構造制約**: ESM import / require / Date.now / Math.random を含めない（generator がコメント除去後のコードを走査して error）。
**ファイル全体が inline 可能**であること（export は行頭接頭辞除去のみで verbatim 注入。export default / export { } は不可）。

**#190 由来のコーディング制約の撤廃**: 旧規約「複数行 template literal 禁止（lines.push + join スタイル維持）」「新規 const は関数内に置く」は旧 regex 抽出 sync test の都合だったため撤廃。区間全文一致方式では canonical の書き方は自由。

**この generator は harness-capability-bound な橋**（W7 表の capability-bound クラスとは別の軸: LLM judge 能力依存ではなく harness 機能依存）。workflow loader が ESM import 不可という harness 制約への対応として存在する。
- 表現: `tools/sync-inlines.mjs` + マーカー区間そのもの
- 再評価トリガ: Claude Code（harness）更新毎に loader の ESM import 可否を再検証し、解禁されたらマーカー区間を `import` 文に置換して generator・統合 sync test ごと撤去する

**exec-proxy も harness-capability-bound な橋**（同じ harness 機能依存軸）。workflow runtime に fs / exec が無いという harness 制約への対応として、決定論スクリプトの実行を dev-runner(-haiku/-haiku-ro) subagent に委譲し stdout を verbatim で返させるパターン（diff-hash / danger-grep / realized-diff / journal / test 実行など 10 箇所超）。least privilege のため capability 別に 3 agent へ分離する（issue #323）: read-only 決定論 proxy（danger-grep / diff-hash / changed-files(realized-diff) / CI checks read / ui-verify config read / base-ref probe）は `dev-runner-haiku-ro`（tools: `[Bash, Read]` のみ）、書き込み・Skill 呼び出しを伴う決定論 proxy（worktree 作成 / deps / test 実行 / redgreen / reconcile-sync / ui-verify server・teardown / journal 書き込み）は `dev-runner-haiku`（tools: `[Bash, Read, Skill]`）、判断寄り（fix/analyze/commit+PR）は `dev-runner`（sonnet）が担う。全 exec-proxy agent の frontmatter には有限の `maxTurns` を設定する（dev-runner-haiku-ro: 10 / dev-runner-haiku: 25 / dev-runner: 50）。maxTurns の agent frontmatter サポートは Claude Code CHANGELOG 上で確認できる最小バージョンとして `2.1.78`（"Added `effort`, `maxTurns`, and `disallowedTools` frontmatter support for plugin-shipped agents" — https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md）を根拠とする。ただし CHANGELOG の文言は "plugin-shipped agents" 限定であり、本 repo の `.claude/agents/*.md`（project-level custom subagent、非 plugin 配布）に対しても同一に runtime honor されるかは一次情報で確認できていない（要 sunset path 的な再検証: 次回 major リリース時に docs/CHANGELOG で project-level agent への適用有無を再確認する）。
- 表現: dev-runner(-haiku/-haiku-ro) verbatim 転写プロンプト群
- 再評価トリガ: harness が workflow への直接 exec（または fs/exec API）を解禁した時点で、当該プロンプト群を直接実行に置換して exec-proxy ごと撤去する

exec-proxy の失敗ポリシーは、決定論ゲートの性質ごとに明示する:

| proxy | 失敗検出 | ポリシー | 理由 |
|-------|----------|----------|------|
| danger-grep / `diff-risk-classify.sh` | `ok:false` / schema 不一致 / 空出力 / command failure | fail-closed（全 SEC seed を unchecked） | W7 軸A invariant の security floor。clean と失敗を同一視しない |
| realized-diff | `null` / schema 不一致 | fail-safe（complex floor） | diff 不明時は shape を安全側へ raise する |
| redgreen | `null` / schema 不一致 | fail-safe（inspection 据え置き） | テスト状態不明時は検査済みにしない |
| diff-hash | `null` / schema 不一致 | fail-open（stale 検出 skip、警告のみ） | stale 検出の補助信号。失敗しても既存の deterministic gate を緩めない |
| ui-verify（`ui-verify-server.sh` / ui-verifier） | `ok:false` / `null` / schema 不一致 | fail-open（skip + telemetry `failed_open`。install 失敗のみ `setup_failed` で区別） | advisory な UI 検証の補助信号。失敗しても既存の deterministic gate を緩めない。teardown は workflow 側 try/finally + 冪等 stop で保証 |
| ci-checks（`gh pr checks`） | `null` / `ok:false` / schema 不一致 / 該当 check 不在（env_key ごとの check-name regex 不一致） / pending | fail-open（対象 ENV item（turbopack-sandbox / bats-sandbox）据え置き、警告 log のみ） | advisory な環境ノート auto-close の補助信号。判定は envChecksGreen（決定論）のみで LLM に委ねず、失敗しても deterministic gate・merge tier 判定を変えない（軸A 不変） |
| final-reconcile（reconcile-sync / test#final） | `null` / `ok:false` / schema 不一致 / 非 fast-forward | fail-safe（`final_reconcile=unavailable` → merge tier HOLD） | fix 適用後の最終 tree の test 状態不明を green と同一視しない（軸A 決定論ゲート）。同様に changed-files-final / ui-verify-config-final は fail-open（UI 再判定・宣言外再監査 skip + 警告 log のみ。test gate は緩めない） |
| final-ac-reconcile（targeted evaluator による既存 AC の最終 tree 再検証） | `null` / schema 不一致 / ac_index 欠落・重複・範囲外 / evidence 空 | fail-safe（`final_ac_reconcile=unavailable` → merge tier HOLD） | fix 適用後の最終 tree での AC 充足不明を satisfied と同一視しない（軸A 決定論検証。fail は既存 AC を uncheck せず critical AC-FINAL-n append — append 単調性・critical-always-blocks 維持） |

### 設計原則 (要約)

1. **機能特化** — 汎用ロール (QA engineer 等) ではなく機能特化スキルを作る
2. **Progressive Disclosure** — description は簡潔に、詳細は `references/` に分離
3. **決定論的処理の分離** — LLM に任せるべきでない処理はスクリプトに抽出
4. **Namespace 命名** — `dev-*`, `blog-*`, `git-*` 等のプレフィックスで整理
5. **小タスクは vanilla** — 小さいタスクは素の Claude Code の方が優秀
6. **Journal Logging** — ワークフロー完了時に skill-retrospective 経由でログ記録
7. **破壊的・大量変更系は `disable-model-invocation: true`** を検討
8. **「毎回確定実行」したい挙動は skill ではなく hook で実装**
9. **後方互換 scaffolding を作らない** — 内製スキルは新形式のみ受理、out-of-enum は schema error

### 並列実装は task 単位 (issue 分割しない)

1 issue 内で並列実装できる箇所は、計画段階で `{serial, parallel}` に分解し、単一 worktree 内で
`parallel()` を使って fan-out する。parallel に置く task は file_changes が互いに disjoint であること
(plan-reviewer が検証)。依存があるものは serial に置く。任意 DAG / 複数 issue 分割は使わない。

### Subagent dispatch — 必須 5 要素

Skill が `Task` / `Agent` tool 経由で subagent を呼び出す場合、以下 5 要素を**必ず含める**:

1. **Objective** — 単一の明確なゴール
2. **Output format** — 期待する構造 (JSON schema / Markdown section / 語数上限)
3. **Tools** — 使用可能 tool と禁止 tool を明示
4. **Boundary** — 触ってはいけないファイル / commit 禁止 / ネットワーク禁止 等
5. **Token cap** — 計測可能な上限

詳細: [`_shared/references/subagent-dispatch.md`](_shared/references/subagent-dispatch.md)

## Commit / PR conventions

Conventional Commits 形式:

```
feat(skill-name):    新規スキル / 機能追加
fix(skill-name):     バグ修正
refactor(skills):    リファクタリング
chore(skill-name):   設定・ドキュメント等
```

dev-flow v2 の PR 運用: child PR は **draft** で作成 (CI suppress)、最終 `integration → main` PR は non-draft で full CI。

@docs/skill-creation-guide.md
