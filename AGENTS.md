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

# 外部スキル (.agents/skills/ — gitignored) の復元 (新規マシンのセットアップ時)
npx skills experimental_install      # tracked の skills-lock.json から一括復元 (per-skill install)
```

Claude Code 限定の代替 (marketplace 経由 install):

```
/plugin marketplace add it-all-playpark/skills
/plugin install playpark-skills@playpark
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
- **「なぜ」は残し「経緯」は書かない** — 判別基準は「次にこのファイルを触る agent の判断を変えるか」。
  不変条件・sunset トリガ・fail-closed の理由は残す (理由なきルールは圧力下で合理化して破られる)。
  比較検討テーブル・不採用案・旧仕様の解説は書かない (腐って現行 invariant と逆を指示する)。追跡は git log / issue

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

### dev-flow / pr-iterate / dev-improve

`/dev-flow` は skill wrapper (`dev-flow/SKILL.md`) が isolation preflight（worktree 作成 →
`EnterWorktree`）を行い、orchestration 本体は dynamic workflow `dev-flow-run`
(`.claude/workflows/dev-flow.js`) が持つ。phase 遷移 / 各ループ / 並列実装の fan-out は
workflow script が JS で保持し、中間 state は script 変数に持つ (外部 state JSON は持たない)。

```
/dev-flow <issue>   → [wrapper preflight] → Setup → Analyze(shape 判定) → Plan
                      → Implement(serial/parallel) → Validate(test green)
                      → Evaluate → PR → workflow('pr-iterate')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → review ⇄ fix loop (LGTM まで, 上限10)。単体起動可
/dev-flow-improve   → Reconcile → Mine → Rank → File → 起票 issue ごとに dev-flow 直列実行
```

不変条件 (どのモデル世代でも緩めない):

- **merge は常に人間** (LGTM 後にユーザーが merge)。全 tier で例外なし。
- **軸A invariant** — deterministic oracle / seed / critical アイテムは全 `gate_policy` で blocking。
  security floor・決定論ゲートを policy で緩めない。
- **1 issue = 1 PR**。並列実装は単一 worktree 内で file-disjoint な task を `pipeline()` で fan-out する。
- **後方互換 scaffolding を作らない** — out-of-enum 値は明示 error (legacy fallback / version 分岐なし)。
- `.claude/workflows/*.js` の `// ==== BEGIN inline: <path> ====` 〜 `// ==== END inline: <path> ====`
  区間は**生成物であり直接編集禁止**。編集は `_lib` の canonical 側で行い
  `tools/sync-inlines.mjs --write` で再生成する（先頭トークン=スクリプトパスの bare 形。sandbox
  excludedCommands は先頭トークンでマッチするため node 前置は付けない）。
- Claude 専用 (workflow 依存)。cross-vendor portability は dev-flow / pr-iterate のみ放棄する例外扱い。

**内部仕様の詳細**（shape 判定と 3 tier 経路 / micro lite route / subagent の model・effort 割り当て /
gate_policy enum / telemetry キー一覧 / W7 distrust 正当化クラスと sunset path / 指示規範性 (prescription) の正当化クラス / inline 生成区間の制約 /
exec-proxy の失敗ポリシー表 / dev-improve のループ設計）は
[`.claude/rules/dev-flow.md`](.claude/rules/dev-flow.md) を参照。
dev-flow 本体 (`.claude/workflows/` / `.claude/agents/` / `_lib/` / `tools/`) を触るときに自動で読み込まれる。

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
`pipeline()` を使って fan-out する。parallel に置く task は file_changes が互いに disjoint であること
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

新規スキル作成の詳細な規約は [`docs/skill-creation-guide.md`](docs/skill-creation-guide.md) を参照
(`/skill-creator` が読み込む)。
