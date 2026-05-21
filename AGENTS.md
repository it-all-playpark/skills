# Project overview

Skills Repository — Claude Code Skills のモノレポ。cross-vendor の coding agent
(Claude Code / Codex CLI / Cursor / Aider / Amp / Gemini CLI / GitHub Copilot /
Devin / Jules / Zed / Continue / Roo Code / Factory Droids / Windsurf / Amazon Q)
で共通の project context を提供する。

This file follows the [agents.md](https://agents.md) standard (Linux Foundation AAIF, 2025-12).
Subdirectory `AGENTS.md` files take precedence over this root file for their respective paths.

## Setup commands

```bash
# 初回セットアップ (git hooks + skill build artifacts)
# PyYAML が必要: pip3 install pyyaml
make setup           # = git config core.hooksPath .githooks + make skills

# Claude Code の ~/.claude/skills を per-skill symlink 構成に変換
make install-link    # = install-claude-skills-link.sh install

# 元の ~/.claude/skills に戻す
make uninstall-link  # = install-claude-skills-link.sh restore

# bats (テストフレームワーク) のインストール
brew install bats-core        # macOS
apt-get install bats          # Ubuntu / Debian

# テスト実行
bash tests/run-all-bats.sh           # ローカル開発 (bats 未インストール時は graceful skip)
bash tests/run-all-bats.sh --strict  # CI 用 (bats 未インストールを error 扱い)

# Skill build artifacts のみ再生成
make skills          # = build-all-skills.sh (idempotent full rebuild)
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

### dev-flow v2 (explicit mode)

- `dev-flow <issue> [--force-single]` — 1 issue = 1 PR (default)
- `dev-flow <issue> --child-split` — parent issue を child issue + integration branch + batch loop に分解

multi-PR coordination は child-issue + integration branch + batch loop モデルで行う。
旧 v1 の subtask DAG (depends_on) + Kahn 法 topological merge + contract branch は**完全削除済**。
詳細: [`docs/ci-skip-recipe.md`](docs/ci-skip-recipe.md)

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

### child-split over DAG

依存関係を持つ複数タスクの coordination は **layered linear batch 配列 + child-issue 分割** を選ぶ
(任意 DAG / depends_on は使わない)。詳細は `docs/skill-creation-guide.md` § 設計原則 参照。

### Cross-agent portability (SKILL.md portable subset)

SKILL.md は **portable subset (8 field)** + **Claude Code 拡張 (12 field)** で構成される。
Codex CLI / Antigravity (agy) など他 agent では拡張 frontmatter が parse error になるため、
cross-agent harness 対応が必要な skill は portable subset のみで書くこと。

**Portable subset** (cross-agent 共通):
`name`, `description`, `version`, `author`, `tags`, `agents`, `license`, `metadata`

**Claude Code 拡張** (vendor-specific, 他 agent で parse error 注意):
`allowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`,
`disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`,
`paths`, `shell`, `when_to_use`

**Lint**:

```bash
# 拡張 frontmatter の使用状況を集計
bash _lib/scripts/lint-portable-frontmatter.sh --root . --json

# 全 SKILL.md が portable subset のみで書かれているか厳密チェック
bash _lib/scripts/lint-portable-frontmatter.sh --root . --strict
```

既存 skill の段階移行は issue #103 のフォローアップで段階的に実施。新規 skill は
原則 portable subset で書き、Claude 拡張が必要な場合は将来の adapter overlay
(`<skill>/adapters/claude.yaml`) 化を念頭に置いて設計すること。

詳細: `docs/skill-creation-guide.md` § Portable subset と Claude Code 拡張

### Adapter overlay wiring (issue #110)

portable SKILL.md + `adapters/claude.yaml` を Claude Code に届けるための wiring。

**問題**: `~/.claude/skills` が `<repo>` への単一 symlink では `<skill>/adapters/claude.yaml`
が Claude Code に届かない (PR #107 で確認)。

**解決**: `make setup` + `make install-link` で以下を構築:

1. `make skills` → `build-all-skills.sh` が `<repo>/.build/skills/<skill>/SKILL.md`
   (portable + overlay merge artifact) を生成
2. `make install-link` → `~/.claude/skills` を **real directory + per-skill symlink** に変換:
   - overlay あり skill → `~/.claude/skills/<skill>` → `<repo>/.build/skills/<skill>/`
   - overlay なし skill → `~/.claude/skills/<skill>` → `<repo>/<skill>/`

**worktree での注意**: 各 worktree は独立した `.build/skills/` を持つ。
`make skills` を worktree 内で実行すると worktree ローカルの `.build/` が生成される。

**CI**: `.github/workflows/lint.yml` の `merged-skill-build` job が
`make skills` → `lint-merged-frontmatter.sh` で merge artifact の内容を検証。
discover 件数 == built 件数の drift check も含む (固定数値は使わない)。

詳細: `_shared/references/portable-coordinator.md` § 6

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
