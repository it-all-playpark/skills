---
name: memory-cli
description: >-
  Cross-agent persistent memory with hybrid search (BM25 + semantic) via memvid CLI.
  Use when: (1) saving knowledge, learnings, or context for future sessions,
  (2) searching past memories across projects,
  (3) keywords like "覚えて", "記憶", "remember", "recall", "memory", "前に話した", "以前の",
  (4) session-load/session-save integration for automatic context persistence.
  Accepts args: <subcommand> [options]
---

# Memory CLI Skill

Cross-agent persistent memory powered by `memvid` CLI (Rust, single-file `.mv2` format).
Hybrid search (BM25 lexical + HNSW vector) with sub-millisecond retrieval.

## References

コマンド詳細やワークフローパターンは必要時に参照:

| 参照先 | 内容 |
|--------|------|
| `references/commands.md` | memvid サブコマンドリファレンス（put, find, view, timeline, stats, etc.） |
| `references/workflows.md` | session-save/load 統合、フィードバック保存パターン |

## Memory File Locations

| ファイル | 用途 |
|---------|------|
| `~/.claude/memory/global.mv2` | 全プロジェクト共通（ユーザー設定、フィードバック、汎用知識） |
| `<project>/.claude/memory/project.mv2` | プロジェクト固有（アーキテクチャ判断、バグパターン等） |

## Configuration

**グローバル設定** (`~/.claude/skills/.claude/skill-config.json`):

```jsonc
{
  "memory-cli": {
    "global_memory": "~/.claude/memory/global.mv2",
    "project_memory": ".claude/memory/project.mv2",
    "default_search_mode": "sem",
    "default_top_k": 5,
    "auto_save": {
      "on_task_complete": true,
      "on_session_end": true,
      "on_feedback": true
    },
    "save_targets": {
      "user": "global",
      "feedback": "global",
      "session": "global",
      "retrospective": "global",
      "project": "project",
      "reference": "project"
    }
  }
}
```

**プロジェクト固有設定** (`<project>/.claude/skill-config.json`) — デフォルトで十分なら不要:

```jsonc
{
  "memory-cli": {
    "project_memory": ".claude/memory/custom-path.mv2",  // カスタムパス
    "tags": ["team=frontend"]                             // 追加タグ
  }
}
```

## Execution Protocol

### Memory File Resolution

1. プロジェクト側 `skill-config.json` → グローバル側を読みマージ（プロジェクト優先）
2. `project_memory` パスにファイルが存在すれば両方検索、なければグローバルのみ
3. `save` 時: `save_targets` に従い振り分け（project ファイル未存在時はグローバルにフォールバック）

### Auto Tag Resolution

`project` タグはリポジトリルートのディレクトリ名から自動生成。手動設定不要。

```
basename $(git rev-parse --show-toplevel) → --tag project=<dirname>
```

プロジェクト側 `skill-config.json` に追加 `tags` があればマージ。

### Auto-Save Behavior

`auto_save` 設定に基づき Claude が自発的に保存（ユーザー確認不要）:

| トリガー | 保存内容 |
|---------|---------|
| タスク完了 | 判断・学び・発見したパターン |
| セッション終了 | セッションサマリー（type=session） |
| フィードバック受領 | ユーザーの修正・指摘（type=feedback） |

保存はバックグラウンドで実行し、作業フローを中断しない。

### Scripts

#### `scripts/memvid-save.sh`

Deterministic put-then-commit wrapper. Ensures the critical `commit` step is never missed.

```bash
# Save to global memory
./scripts/memvid-save.sh --target global --title "Title" --content "Content" --type feedback --tags "team=frontend" --uri "feedback/2026-03-16/slug"

# Save to project memory (falls back to global if project.mv2 missing)
./scripts/memvid-save.sh --target project --title "Title" --content "Content" --type project
```

Output: `{"status": "saved", "target": "<path>", "title": "<title>", "type": "<type>", "committed": true}`

The LLM decides WHAT to save (content generation); this script handles the deterministic save-and-commit flow.

### Critical Rules

1. **`put` 後は必ず `commit` する:** 未commitフレームはWAL（Write-Ahead Log）にのみ存在し、永続化されない。`memvid commit <FILE.mv2>` を `put` の後に必ず実行すること。
2. **`create` は新規ファイルのみ:** `memvid create` は既存 `.mv2` ファイルを**上書き**する。既存ファイルへの追記は `put` を使う。
3. **`enrich` で検索品質向上:** 定期的に `memvid enrich <FILE.mv2> --engine rules` を実行すると、エンティティが抽出され `state`/`facts` コマンドでの O(1) ルックアップが有効になる。
