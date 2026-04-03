# Error Handling

## Error Handling by Phase

| Phase | On Failure |
|-------|------------|
| 1-2 | Abort, update state |
| 3 | Analyze error -> retry with context (max 2). Still fails -> pause |
| 4 | Analyze error -> retry with feedback (max 2). Still fails -> pause |
| 5 | Retry with --fix (max 2). Analyze failure between retries. Still fails -> pause |
| 6 | Retry once, then skip with warning |
| 7 | Retry once (re-stage if needed). Still fails -> report command, save state |
| 8 | Retry once. Still fails -> report command, save state |

## Auto-Retry Protocol

Phases 3-5 の失敗時は以下のプロトコルに従う:

1. **エラー分析**: 失敗出力を読み、根本原因を特定
2. **修正リトライ**: エラーコンテキストを付与して再実行（同じコマンドの盲目的リトライ禁止）
3. **journal 記録**: リトライ回数を `recovery.turns_spent` に記録
4. **pause 判断**: max リトライ超過時のみユーザー介入を要求

```
失敗 -> エラー分析 -> 修正して再実行 (1回目)
  -> まだ失敗 -> 別アプローチで再実行 (2回目)
    -> まだ失敗 -> journal partial 記録 -> pause for intervention
```

## Detailed Phase Failure Handling

### Phase 1-2 Failures

```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh $PHASE failed \
  --error "Error message" \
  --worktree $PATH
```

Action: Abort workflow, report error.

### Phase 3 Failures (Implementation Plan)

1. エラー出力を分析し、原因を特定（issue 要件の曖昧さ、コードベース理解不足等）
2. エラーコンテキストを付与して dev-plan-impl を再実行（max 2回）
3. 2回失敗後 -> journal に partial 記録 -> pause for intervention

### Phase 4 Failures (Implementation)

1. エラー出力を分析し、原因を特定（型エラー、ロジックエラー、依存関係不足等）
2. エラーコンテキストと修正方針を付与して dev-implement を再実行（max 2回）
3. 2回失敗後 -> journal に partial 記録 -> pause for intervention

### Phase 5 Failures (Validation)

1. `--fix` で自動修正を試行
2. 失敗した場合、エラー出力を分析し原因別に対処:
   - lint エラー -> 該当箇所を直接修正して再度 `--fix`
   - テスト失敗 -> テストまたは実装を修正して再度 `--fix`
   - 型エラー -> 型定義を修正して再度 `--fix`
3. max 2回リトライ後も失敗 -> journal に partial 記録 -> pause for intervention

### Phase 7-8 Failures (Commit / PR)

1. 自動リトライ1回（Phase 7: re-stage して再コミット、Phase 8: 再実行）
2. それでも失敗 -> manual command を報告、state 保存

Manual recovery:
```bash
# Phase 7
git add -A && git commit -m "feat: ..."

# Phase 8
gh pr create --title "..." --body "..."
```
