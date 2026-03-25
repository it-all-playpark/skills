# Skill Creation Guide

Claude Code Skills のベストプラクティス集。

## Skill ディレクトリ構造

```
skill-name/
├── SKILL.md              # Frontmatter + ワークフロー（必須）
├── scripts/              # 決定論的処理（bash/python）
│   └── *.sh / *.py
└── references/           # Progressive disclosure 用の詳細ドキュメント
    └── *.md
```

## SKILL.md Frontmatter

```yaml
---
name: skill-name                    # slash-command 識別子
description: |                      # 常にコンテキスト注入される（簡潔に）
  One-line summary.
  Use when: (1) trigger condition, (2) another condition,
  (3) keywords: keyword1, keyword2, keyword3
  Accepts args: <required> [--optional value]
allowed-tools:                      # 許可ツール（省略時はデフォルト）
  - Bash
  - Skill
  - Task
model: sonnet                       # 実行モデル（省略可）
context: fork                       # fork で別コンテキスト（省略可）
agent: general-purpose              # context:fork 時のエージェント型（省略可）
disable-model-invocation: false     # true で自動呼び出し禁止
user-invocable: true                # false でメニュー非表示（background knowledge 専用）
---
```

### Frontmatter 全10フィールド

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | 表示名・slash-command 識別子 |
| `description` | Yes | autocomplete・auto-discovery に使用。**常にコンテキスト消費**するため簡潔に |
| `argument-hint` | No | autocomplete ヒント |
| `allowed-tools` | No | 許可ツールリスト |
| `model` | No | 実行モデル指定 |
| `context` | No | `fork` で分離サブエージェント |
| `agent` | No | `context:fork` 時のサブエージェントタイプ |
| `hooks` | No | ライフサイクルフック |
| `disable-model-invocation` | No | `true` で自動呼び出し禁止（危険スキル向け） |
| `user-invocable` | No | `false` でメニュー非表示（background knowledge 専用） |

### description の書き方

description は**常にコンテキストに注入される**（character budget デフォルト 15,000 文字）。

```yaml
# Good: トリガー条件・キーワード・引数を含む簡潔な記述
description: |
  Generate SNS posts from blog content.
  Use when: (1) SNS告知文が必要, (2) keywords: SNS告知, 投稿文, announce
  Accepts args: <source> [--platforms LIST]

# Bad: 長すぎる説明、実装詳細の記述
description: |
  This skill reads MDX files, extracts metadata, generates platform-specific
  posts for X (280 chars), LinkedIn (1300 chars), and Facebook (1500 chars),
  with hashtag optimization and scheduling support...
```

## SKILL.md 本文構造

```markdown
# Skill Title

One-line description.

## Usage

```
/skill-name <required> [--optional value]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<required>` | required | 説明 |
| `--optional` | `default` | 説明 |

## Workflow

```
Step 1 → Step 2 → Step 3
```

## Step N: Title

具体的な手順。スクリプト呼び出しは `$SKILLS_DIR/skill-name/scripts/` を使用。

## References

- [Detail Doc](references/detail.md) - 詳細説明
```

### Progressive Disclosure パターン

SKILL.md はワークフロー概要のみ。詳細は `references/` に分離。

```markdown
## Step Summary

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: analyze` | Analysis done |
| 2 | `scripts/process.sh` | Output generated |

Details: [Step Details](references/step-detail.md)
```

## Scripts ディレクトリ

決定論的処理（LLM に任せるべきでない処理）はスクリプトに抽出する。

```bash
# スクリプト呼び出しパターン
$SKILLS_DIR/skill-name/scripts/script-name.sh [args]
```

### スクリプト化すべき処理

- ファイル検索・パターンマッチング
- JSON/YAML の読み書き
- git 操作
- API 呼び出し（curl ベース）
- 状態管理（state ファイルの読み書き）

### スクリプト化すべきでない処理

- 文脈を考慮した判断
- コード生成・レビュー
- 自然言語の生成・分析

## 共有リソース

```
_shared/
├── references/      # 共有ドキュメント
└── scripts/         # 共有スクリプト

_lib/
├── common.sh        # 共有 bash ユーティリティ
├── config.py        # 共有 Python 設定
├── scripts/         # 共有インフラスクリプト
└── templates/       # 共有テンプレート
```

## Skill / Agent / Command の使い分け

| 種別 | 用途 | 自動呼び出し | コンテキスト |
|------|------|-------------|-------------|
| **Skill** | 再利用可能手順、progressive disclosure | Yes | inline |
| **Agent** | 自律マルチステップ、永続メモリ | Yes（別コンテキスト） | fork |
| **Command** | オーケストレーション、ユーザー起動 | No | inline |

**優先順位**: Skill（最軽量）> Agent（別コンテキスト）> Command（自動不可）

### オーケストレーションパターン

```
User triggers /command
  → Command orchestrates
  → Command invokes Agent (別コンテキスト)
    → Agent uses preloaded Skill (ドメイン知識)
  → Command invokes Skill (inline 出力生成)
```

## 設計原則

1. **機能特化**: 汎用ロール（QA engineer 等）ではなく機能特化スキルを作る
2. **Progressive Disclosure**: description は簡潔に、詳細は references/ に分離
3. **決定論的処理の分離**: LLM に任せるべきでない処理はスクリプトに抽出
4. **Namespace 命名**: `dev-*`, `blog-*`, `git-*` 等のプレフィックスで整理
5. **小タスクは vanilla**: 小さいタスクは素の Claude Code の方が優秀
6. **Journal Logging**: ワークフロー完了時に skill-retrospective 経由でログ記録

## skill-config.json

スキル固有の設定は `skill-config.json`（リポジトリルート）に集約。

```json
{
  "skill-name": {
    "setting_key": "value"
  }
}
```

### Config 解決順序

**グローバル**: `$SKILL_CONFIG_PATH` > `~/.config/skills/config.json` > `~/.claude/skill-config.json`

**プロジェクト**: `$git_root/skill-config.json` > `$git_root/.claude/skill-config.json`

スクリプトからは `_lib/common.sh` の `load_skill_config` / `merge_config` を使用。
LLM からは Read ツールで `skill-config.json` を直接読み取る。
