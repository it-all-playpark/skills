# dev-decompose Dry-Run Mode

`--dry-run` は Steps 1-4（分析 + ファイルグループ化）のみを実行し、ブランチ・worktree・flow.json を一切作らない軽量モード。`dev-flow` の auto-detect が parallel/single 判定のために使用する。

## 実行ステップ

```
1. Read issue analysis (from dev-issue-analyze output or issue body)
2. Identify affected files and dependencies
2b. Read past integration feedback via analyze-past-conflicts.sh
    (files + directory prefixes that recurred in previous conflicts)
3. Group files into subtasks (no file overlap), biasing files flagged by
   step 2b toward the same subtask when possible
4. Apply fallback criteria (see Decomposition Guide)
→ Return assessment JSON (no side effects)
```

## 過去フィードバックの読み込み

```bash
$SKILLS_DIR/dev-decompose/scripts/analyze-past-conflicts.sh \
  --affected-files "src/types/user.ts,src/api/auth.ts,..." \
  --limit 50 --min-occurrences 2
```

出力形状（情報提供。最終判断は decomposer LLM）:

```jsonc
{
  "has_hints": true,
  "scanned_events": 42,
  "recurring_files": [
    {"file": "src/types/user.ts", "occurrences": 3,
     "lessons": ["同じ types/ 配下は 1 subtask にまとめるべき"]}
  ],
  "recurring_prefixes": [
    {"prefix": "src/types", "occurrences": 4}
  ]
}
```

pub/sub パターンの詳細は [`_shared/references/integration-feedback.md`](../../_shared/references/integration-feedback.md) を参照。

## 出力例

```json
// single_fallback
{"status": "single_fallback", "reason": "Fewer than 4 affected files", "file_count": 2}

// ready for parallel
{"status": "ready", "subtask_count": 3, "file_groups": [
  {"id": "task1", "files": ["src/models/user.ts", "src/models/user.test.ts"]},
  {"id": "task2", "files": ["src/routes/auth.ts", "src/middleware/jwt.ts"]}
]}
```

dry-run の JSON には `past_conflict_hints` フィールドが含まれ、`analyze-past-conflicts.sh` の出力が観測用にそのまま入る。

```jsonc
// Ready for parallel
{
  "status": "ready",
  "subtask_count": N,
  "file_groups": [{"id": "taskN", "files": ["..."]}],
  "past_conflict_hints": {
    "has_hints": true,
    "scanned_events": 42,
    "recurring_files": [{"file": "src/types/user.ts", "occurrences": 3, "lessons": ["..."]}],
    "recurring_prefixes": [{"prefix": "src/types", "occurrences": 4}]
  }
}

// Fallback to single
{"status": "single_fallback", "reason": "<criteria from Decomposition Guide>", "file_count": N, "past_conflict_hints": {...}}
```

`past_conflict_hints` は `_shared/integration-feedback.json` を読む。feedback ファイルが無いか空なら `{"has_hints": false, ...}` となり、decomposition は通常通り進む。

## Resume

dry-run の結果から full execution に進む場合:

```bash
Skill: dev-decompose $ISSUE --resume /path/to/dry-run-result.json --base $BASE
```
