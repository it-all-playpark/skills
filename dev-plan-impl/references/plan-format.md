# Implementation Plan Format

## Output Path

`$WORKTREE/.claude/impl-plan.md`

On retry, overwrite the existing file (history is tracked in kickoff.json iterations).

## Template

```
# Implementation Plan

## Overview
[1-2文: 何を、なぜ実装するか]

## File Changes
| File | Action | Description |
|------|--------|-------------|
| path/to/file | create/modify/delete | 変更内容の説明 |

## Test Plan
| AC ID | Test File | Test Name | Type | Expected Initial State |
|-------|-----------|-----------|------|------------------------|
| AC1 | tests/foo.test.ts | returns empty array for no input | unit | RED (function not implemented) |

**必須ルール**（`config.testing` が `none` 以外の場合）:
- 全 acceptance criterion (AC) に対し最低 1 テストを割り当てる
- `Expected Initial State` は `RED`（未実装なので失敗する）を基本とする。既存機能の拡張で既に通るテストがある場合のみ `GREEN` 可
- 各テストは `dev-implement` の red-green-refactor ループで、先に書いて RED を確認してから実装に入る

## Architecture Decisions
- [設計判断とその理由。なぜこのアプローチを選んだか]

## Edge Cases
- [考慮すべきエッジケース。各ケースの対応方針]

## Dependencies
- [外部ライブラリ、内部モジュール依存。バージョン制約があれば記載]

## Notes for Retry
[Evaluator feedback があれば、それに対する具体的な対応方針を記載]
[初回実行時はこのセクションを省略可]
```

## Guidelines

- **具体的に**: "ファイルを作成" ではなく "src/models/user.ts に User 型を定義" のように書く
- **Architecture Decisions は理由を書く**: 判断だけでなく、なぜその判断をしたかを含める
- **Edge Cases は対応方針まで**: 「空リストの場合」だけでなく「空リストの場合は 200 + 空配列を返す」
- **File Changes は網羅的に**: テストファイル、設定ファイルの変更も含める
- **Test Plan は AC と 1:1 対応**: AC ID を必ず記載。テスト不能な AC は dev-plan-review で critical になる
