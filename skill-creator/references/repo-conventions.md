# Repo Conventions (Skill Creator Pointer)

当リポジトリで skill を作成する際の canonical source は [`docs/skill-creation-guide.md`](../../docs/skill-creation-guide.md)。

## 押さえるべき4点

1. **Namespace prefix** — `dev-*`, `blog-*`, `git-*`, `sns-*`, `repo-*`, `seo-*` 等でカテゴリを揃える
2. **Shared resources** — 重複ロジックは `_shared/scripts/` または `_lib/common.sh` に抽出
3. **Config** — skill 固有設定は repo root の `skill-config.json` に集約（`.claude/` 内に書かない）
4. **Journal logging** — ワークフロー成功/失敗時に `skill-retrospective/scripts/journal.sh` でログ記録

## Subagent を呼ぶ skill の追加ルール

`Task` / `Agent` tool を呼ぶ場合は [`_shared/references/subagent-dispatch.md`](../../_shared/references/subagent-dispatch.md) の5要素（Objective / Output format / Tools / Boundary / Token cap）と routing rule を遵守する。SKILL.md 本文または references/ から reference を貼ること。

## 詳細

- [Skill Creation Guide](../../docs/skill-creation-guide.md) - frontmatter 全 10 フィールド、progressive disclosure パターン、Skill/Agent/Command の使い分け
- [Subagent Dispatch Rules](../../_shared/references/subagent-dispatch.md) - subagent 呼び出し必須5要素と失敗モード
