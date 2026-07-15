# Seed Refresh アルゴリズム詳細

## リフレッシュロジック

1. 各 `seed/*/manifest.json` を読み込む
2. `source` または `url` フィールドからソースリポジトリを解決
3. `manifest.json.exportedAt` と `--branch`（デフォルト: `main`）の最新コミット時刻を比較
4. リポジトリに新しいコミットがある場合のみ再取得（`--force` で強制）
5. 以下のファイルをすべて再取得:
   - `exported.md`（repomix（markdown スタイル）で再生成。`--compress` は F3 の live smoke
     （octocat/Hello-World、`.devflow-tmp/repomix-format-verification.md`）でトークン削減が
     確認できなかったため未使用。`exportTokens` トークン計測値は manifest.json に記録
     （計測不能時は省略。`exportTokensRaw` / `exportTokenReductionPct` は `--compress` 使用時のみ
     付与される仕組みを残しているが現在は付与されない）
   - `commits.md`
   - `issues.md`
   - `pr-summary.md`
6. 成功後、`manifest.json.exportedAt` を現在の UTC タイムスタンプに更新

## Dependencies

- `gh` authenticated (`gh auth status`)
- `python3`
- `repomix`（export_repo.py が内部で使用。未インストール時は npx で自動取得）
- 既存グローバルスキル:
  - `~/.claude/skills/repo-export/scripts/export_repo.py`
  - `~/.claude/skills/repo-commit/scripts/export_commit.py`
  - `~/.claude/skills/repo-issue/scripts/export_issue.py`
  - `~/.claude/skills/repo-pr/scripts/export_pr.py`
