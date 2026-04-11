# dev-flow-doctor ↔ skill-retrospective Responsibility Split

`dev-flow-doctor` と `skill-retrospective` はいずれも `~/.claude/journal/*.json` を
入力源にするが、**対象範囲・目的・出力**が異なる。重複実装を避けるため、dev-flow-doctor は
journal アクセスを `skill-retrospective/scripts/journal.sh` 経由で行い、そのうえで
**dev-flow 系 skill の連携健全性**に特化した集計を行う。

## 対比表

| 観点 | skill-retrospective | dev-flow-doctor |
|------|---------------------|------------------|
| **対象** | 全 skill（journal 全体） | dev-flow family に限定（既定 8 skill） |
| **目的** | 汎用的な失敗パターン検出と自己改善 proposal | dev-flow pipeline の **connector 健全性** |
| **主な検出** | failure category 集計、再発パターン、proposal 生成 | dead phase / stuck skill / bottleneck / disconnected skill |
| **入力** | `~/.claude/journal/*.json` 全体 | journal を family_skills でフィルタ |
| **出力** | proposal JSON / patch | `claudedocs/dev-flow-health-*.md` + 構造化 JSON |
| **実行トリガ** | failure 発生時 / セッション終了 / meta-retrospective | 定期（weekly / on-demand） |
| **スコアリング** | なし（proposal ベース） | 0–100 health score |

## dev-flow family（既定）

`skill-config.json` の `dev-flow-doctor.family_skills` で上書き可能。既定値は以下の 8 skill:

- `dev-kickoff` — orchestrator（parent）
- `dev-implement`
- `dev-validate`
- `dev-integrate`
- `dev-evaluate`
- `pr-iterate`
- `pr-fix`
- `night-patrol`

これら以外の skill（`blog-*`, `sns-*`, `skill-creator` など）は dev-flow-doctor の対象外である。
それらの健全性は `skill-retrospective` の全体統計で確認する。

## 4 検出カテゴリの定義

| カテゴリ | 定義 | 既定閾値 |
|---------|------|----------|
| **dead phase** | window 内で `success` 実行が 0 件の family skill | 0 success |
| **stuck skill** | `(failure + partial) / total > threshold`、かつ `total >= stuck_min_total` | 0.30 / 3 |
| **bottleneck** | `avg(duration_turns)` の上位 N 件 | top 3 |
| **disconnected skill** | window 内で自身の entry が 0 件 **かつ** 親 skill（hook-capture の Skill tool invocation）で一度も参照されていない | 両条件とも 0 |

## dev-flow-doctor が依存するもの

- `skill-retrospective/scripts/journal.sh`（query / stats）を直接呼ぶのではなく、
  dev-flow-doctor 側は同じ journal ディレクトリ（`$CLAUDE_JOURNAL_DIR` もしくは
  `~/.claude/journal`）を直接読むシンプルな jq 処理で済ませる。
  `journal.sh` の API と同等の読み取りロジック（ISO since filter、skill filter）を
  `analyze-dev-flow-family.sh` 内で再実装している。これは skill-retrospective 側の
  内部変更に影響されないようにするための意図的な最小依存である。

## 境界の明示（ガードレール）

- dev-flow-doctor は **proposal を生成しない**。改善提案は skill-retrospective の
  「提案→承認→適用」フローに乗せる。
- dev-flow-doctor の `--fix` は worktree cleanup などの safe fix に限定し、
  skill 本体への変更は一切行わない。
- skill-retrospective が dev-flow-doctor を呼び出すことは無い。逆方向も同様に
  直接呼び出しはしない（それぞれ独立に実行される）。
