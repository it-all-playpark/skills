# Dev Flow - Journal Logging

ワークフロー完了時に skill-retrospective journal へ実行ログを記録する。

**CRITICAL: 元の呼び出し引数を必ず `--args` で渡すこと。** usage patterns のトラッキングに必要。

## MODE の決定 (v2)

| 条件 | MODE 値 |
|------|---------|
| `--force-single` 指定 / フラグなし (default) | `single` |
| `--child-split` 指定 | `child-split` |
| `--force-parallel` / `--parallel` | **エラー** (v2 で削除) |

## Logging Commands

```bash
# On success (LGTM achieved)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow success \
  --issue $ISSUE --duration-turns $TURNS --args "$ORIGINAL_ARGS" --mode "$MODE"

# On failure (any step fails)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --args "$ORIGINAL_ARGS" --mode "$MODE"
```

- `$ORIGINAL_ARGS`: dev-flow に渡された引数文字列全体 (e.g. `"42 --child-split --testing tdd"`)
- `$MODE`: 解決されたモード (`single` / `child-split`)

Note: dev-kickoff と pr-iterate も独自にログを記録する。dev-flow のログはフロー全体の結果を記録するもの。
