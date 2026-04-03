# Skill-Aware Planning

実装計画時に、インストール済みスキルの中に
タスクの一部または全部を処理できるものがないか確認する。
該当するスキルがあれば、手動実装より Skill 呼び出しを優先する。
複数スキルの組み合わせや、スキル + 手動コード変更の混在も可能。

## 判断基準

- issue の内容がスキルの description に合致するか
- スキルの出力（ファイル変更）が issue の要件を満たすか
- 手動実装より効率的か

## 例

- bounce率改善の issue → `Skill: blog-seo-improve --type bounce`
- 内部リンク不足の issue → `Skill: blog-internal-links --fix`
- クラスタ立ち上げ → `Skill: blog-cluster-launch "Claude Code"`
- 複合: SEO改善 + リンク追加 → 両スキルを順番に呼び出し
