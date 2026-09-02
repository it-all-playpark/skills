# Seed Refresh アルゴリズム詳細

## リフレッシュロジック

1. 各 `seed/*/manifest.json` を読み込む
2. `source` または `url` フィールドからソースリポジトリを解決
3. `manifest.json.exportedAt` と `--branch`（デフォルト: `main`）の最新コミット時刻を比較
4. リポジトリに新しいコミットがある場合のみ再取得（`--force` で強制）
5. 以下を再取得:
   - `commits.md`（`--limit 50 --since <--commit-since、既定 45d>`。`--since` は
     export_commit.py にそのまま渡され、GitHub API `since=` と同じ committer date 基準で
     フィルタされる）
   - `issues.md`
   - `pr-summary.md`
   - `exported.md`（`--with-export` 指定時のみ。未指定時は生成せず、manifest.json の
     `exportTokens` / `exportTokensRaw` / `exportTokenReductionPct` の 3 キーも変更しない）
     - repomix（markdown スタイル）で再生成。`--compress` は F3 の live smoke
       （octocat/Hello-World、`.devflow-tmp/repomix-format-verification.md`）でトークン削減が
       確認できなかったため未使用。`exportTokens` トークン計測値は manifest.json に記録
       （計測不能時は省略。`exportTokensRaw` / `exportTokenReductionPct` は `--compress` 使用時のみ
       付与される仕組みを残しているが現在は付与されない）。
     - 既定で tests 系パス
       (`**/[Tt]ests/**,**/*.test.*,**/*.spec.*,**/__tests__/**,**/testdata/**,**/__snapshots__/**,**/fixtures/**`)
       を repo-export の `--ignore <comma区切りglob文字列>` passthrough 経由で除外する
       （seed 用途のトークン削減目的）。per-seed で opt-out するには `manifest.json` に
       `"includeTests": true` を設定する（省略または `false` は既定除外を適用）。
     - `includeTests` が boolean 以外の値の場合は `--with-export` の有無によらず export 系
       コマンドを一切実行せず、当該 seed を `status: error` / `reason: invalid_includeTests`
       にする（fail-closed）
6. 成功後、`manifest.json.exportedAt` を現在の UTC タイムスタンプに更新

## Dependencies

- `gh` authenticated (`gh auth status`)
- `python3`
- `repomix`（export_repo.py が内部で使用。未インストール時は npx で自動取得）
- 同 repo 内の skill（本 skill ディレクトリの sibling として解決）:
  - `../repo-export/scripts/export_repo.py`
  - `../repo-commit/scripts/export_commit.py`
  - `../repo-issue/scripts/export_issue.py`
  - `../repo-pr/scripts/export_pr.py`
