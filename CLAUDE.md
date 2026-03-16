# Skills Repository

Claude Code Skills のモノレポ。

## Skill 作成・編集ルール

@docs/skill-creation-guide.md

## プロジェクト構造

```
skills/
├── skill-name/           # 各スキル
│   ├── SKILL.md          # Frontmatter + ワークフロー
│   ├── scripts/          # 決定論的処理
│   └── references/       # 詳細ドキュメント
├── _shared/              # 共有リソース（references, scripts）
├── _lib/                 # 共有ライブラリ（common.sh, config.py）
├── .agents/skills/       # 外部スキル（symlink）
├── .claude/skill-config.json  # スキル固有設定
└── docs/                 # プロジェクトドキュメント
```

## 開発ルール

- **SKILL.md の description は簡潔に** — 常にコンテキスト消費される（15,000 文字 budget）
- **決定論的処理はスクリプトに抽出** — ファイル検索、JSON操作、git操作、API呼び出し
- **Progressive Disclosure** — SKILL.md は概要、詳細は `references/` に分離
- **Namespace 命名** — `dev-*`, `blog-*`, `git-*`, `sns-*` 等でグループ化
- **既存パターンに従う** — 新規スキルは同カテゴリの既存スキルを参考にする
- **共有処理は `_shared/` か `_lib/`** — スキル間で重複するロジックは共有化

## コミット規約

Conventional Commits 形式: `feat(skill-name):`, `fix(skill-name):`, `refactor(skills):`
