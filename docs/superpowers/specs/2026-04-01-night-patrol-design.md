# Night Patrol - 自律巡回開発スキル設計

## 概要

寝ている間にコードベースを巡回し、issue発見→作成→実装→PRレビュー→nightlyブランチへのマージを自律的に繰り返すオーケストレータースキル。

## 要件

- **起動**: 手動 (`/night-patrol`)
- **対象**: 呼び出し元のリポジトリ
- **issue発見ソース**: 静的解析 (A)、テスト失敗 (B)、未アサインGitHub Issue (C)
- **処理量**: 全件処理（上限なし、安全ガードで制御）
- **マージ先**: `nightly/YYYY-MM-DD` → 朝にユーザーが `dev` へマージ判断
- **通知**: ファイルレポート + Telegram通知

## アーキテクチャ

```
/night-patrol (手動起動、フル実行: Phase 1-4)
│
├─ Phase 1: Scan (ハイブリッドモード)
│  ├─ 通常モード (デフォルト):
│  │  ├─ scripts/scan-lint.sh      → lint/型エラー/TODO/脆弱性
│  │  ├─ scripts/scan-tests.sh     → テスト失敗・スキップ検出
│  │  └─ scripts/scan-issues.sh    → 未アサインissue取得
│  └─ --deep モード:
│     ├─ Skill: code-audit-team (既存、Agent Team)
│     │   → security/performance/architecture の多角的分析
│     ├─ scripts/scan-tests.sh     → テスト失敗・スキップ検出
│     └─ scripts/scan-issues.sh    → 未アサインissue取得
│  出力: scan-results.json
│
├─ Phase 2: Triage
│  ├─ 重複チェック (scripts/check-duplicates.sh + LLM類似度判定)
│  ├─ LLMグルーピング・優先度判定
│  ├─ 依存解析 (scripts/analyze-dependencies.sh + LLM論理依存判定)
│  ├─ 安全ガードフィルタ (scripts/guard-check.sh)
│  └─ GitHub Issue 作成 (A/B由来の新規分のみ)
│  出力: triage-results.json
│
├─ Phase 3: Execute (バッチ実行)
│  └─ for each batch in execution_plan.batches (順序通り):
│     ├─ guard-check.sh --pre-execute (累積変更量チェック)
│     │   └─ 超過 → 残りバッチ全てスキップ
│     ├─ parallel batch → 複数 dev-flow を Task subagent で並列起動
│     │   serial batch  → dev-flow を1つずつ直列実行
│     ├─ dev-flow 結果に応じて:
│     │   ├─ LGTM → nightly/YYYY-MM-DD へマージ
│     │   ├─ max_reached → スキップ、レポート記録
│     │   └─ エラー中断 → スキップ、レポート記録
│     ├─ バッチ内の1issueが失敗しても他issueは続行
│     └─ night-patrol.json 更新
│
├─ Phase 4: Report
│  ├─ claudedocs/night-patrol/YYYY-MM-DD.md 出力
│  └─ Telegram 通知送信
│
└─ 状態管理: .claude/night-patrol.json
```

## ブランチ戦略

```
main
├── dev                      ← 常設。朝にユーザーが nightly → dev マージ判断
└── nightly/YYYY-MM-DD       ← 巡回で作成 (dev から分岐)
    ├── PR #1 merged
    ├── PR #2 merged
    └── PR #3 merged
```

- dev-flow が作る各 feature branch の PR ターゲットは `nightly/YYYY-MM-DD`
- 巡回完了後、nightly ブランチはそのまま残す（ユーザーが朝に確認）

## スキル構成 (1スキル + サブコマンド)

### night-patrol

```yaml
name: night-patrol
description: |
  Autonomous code patrol - scan, triage, implement, and report.
  Use when: (1) 自律巡回開発, (2) keywords: night patrol, 夜間巡回, 自動修正
  Accepts args: [scan|triage|execute|report] [--dry-run] [--deep] [--max-issues N]
```

**使い方:**

```
/night-patrol                → フル実行 (Phase 1-4)
/night-patrol scan           → Phase 1 のみ (scan-results.json 出力)
/night-patrol triage         → Phase 2 のみ (scan-results.json が必要)
/night-patrol execute        → Phase 3 のみ (triage-results.json が必要)
/night-patrol report         → Phase 4 のみ (night-patrol.json が必要)
/night-patrol --dry-run      → Phase 1-2 + レポートのみ出力
/night-patrol --deep         → Phase 1 で code-audit-team 使用
/night-patrol scan --deep    → deep スキャンのみ実行
```

**引数:**

| Arg | Default | Description |
|-----|---------|-------------|
| サブコマンド | (なし=フル実行) | `scan`, `triage`, `execute`, `report` で個別Phase実行 |
| `--dry-run` | false | Phase 2 (Triage) まで実行し、レポートのみ出力 |
| `--deep` | false | Phase 1 で code-audit-team を使った多角的スキャン（コスト高） |
| `--max-issues` | unlimited | 処理するissue数の上限 |

**状態ファイル: `.claude/night-patrol.json`**

```json
{
  "date": "2026-04-01",
  "branch": "nightly/2026-04-01",
  "status": "executing",
  "phase": 3,
  "issues_total": 5,
  "issues_completed": 2,
  "issues_failed": 0,
  "issues_skipped": 1,
  "cumulative_lines_changed": 245,
  "results": [
    {"issue": 456, "pr": 789, "status": "merged", "lines": 30},
    {"issue": 123, "pr": 790, "status": "merged", "lines": 120},
    {"issue": 234, "pr": null, "status": "skipped", "reason": "exceeded_line_limit"}
  ]
}
```

## Phase 詳細

### Phase 1: Scan

**通常モード (デフォルト):**

| ソース | スクリプト | 検出内容 |
|--------|-----------|----------|
| 静的解析 | `scripts/scan-lint.sh` | lint警告、型エラー、TODO/FIXME、未使用export、脆弱性 (`npm audit`) |
| テスト | `scripts/scan-tests.sh` | 失敗テスト、スキップされたテスト (`.skip`/`.todo`) |
| GitHub Issues | `scripts/scan-issues.sh` | 未アサイン＆ラベルフィルタ対応 |

- プロジェクト種別の自動検出は `dev-validate` のパターンを流用
- スキャンスクリプトは全て冪等・副作用なし

**--deep モード:**

通常モードのスクリプトに加え、`code-audit-team` (既存スキル) を実行。
- security/performance/architecture の3専門エージェントによる多角的分析
- code-audit-team の findings を scan-results.json の `audit` ソースとして統合
- コスト高（$5-15/回）のため週1-2回の使用を推奨

**出力: `scan-results.json`**

```json
{
  "scan_date": "2026-04-01T23:00:00Z",
  "mode": "normal",
  "sources": {
    "lint": [
      {"type": "type_error", "file": "src/foo.ts", "line": 42, "message": "..."}
    ],
    "tests": [
      {"type": "failing", "test": "auth.test.ts", "suite": "login", "error": "..."}
    ],
    "issues": [
      {"number": 123, "title": "...", "labels": ["bug"], "created_at": "..."}
    ],
    "audit": []
  },
  "counts": {"lint": 5, "tests": 2, "issues": 3, "audit": 0, "total": 10}
}
```

`--deep` モード時は `audit` に code-audit-team の findings が入り、`mode` が `"deep"` になる。

### Phase 2: Triage

**ワークフロー:**

1. **重複チェック** — `scripts/check-duplicates.sh` で open issue 一覧取得 → LLM が類似度判定
   - 重複あり → 既存issueに紐付け（新規作成スキップ、処理対象に追加）
   - 部分重複 → 既存issueにコメント追記、新規作成スキップ
   - 重複なし → 新規issue作成へ
2. **グルーピング** — LLM が関連する検出結果をまとめて1issueに（A/B由来のみ）
3. **安全ガードフィルタ** — `scripts/guard-check.sh --pre-triage`
4. **優先度付け** — LLM がスコアリング (critical > high > medium > low)
5. **依存解析** — issue間の関係を分析し実行プランを生成
   - `scripts/analyze-dependencies.sh` で各issueの推定対象ファイルを抽出
   - ファイル重複グラフを構築（同じファイルを触るissueを検出）
   - LLM が論理依存を判定（issue A の修正が issue B の前提になるケース）
   - 実行プラン生成:
     - 独立したissueは並列バッチにまとめる
     - ファイル競合・論理依存のあるissueは直列チェーンに
     - バッチ内の優先度: critical > high > medium > low
6. **Issue 作成** — 新規分のみ `gh issue create`、ラベル: `night-patrol` + 優先度

**優先度基準:**

| Priority | 対象 |
|----------|------|
| critical | テスト失敗、セキュリティ脆弱性 |
| high | 型エラー、バグissue |
| medium | lint警告、enhancement issue |
| low | TODO/FIXME、cosmetic |

**出力: `triage-results.json`**

```json
{
  "triage_date": "2026-04-01T23:05:00Z",
  "issues": [
    {
      "number": 456,
      "title": "Fix failing auth tests",
      "priority": "critical",
      "source": "tests",
      "action": "created",
      "estimated_lines": 30,
      "estimated_files": ["src/auth.ts", "tests/auth.test.ts"]
    }
  ],
  "execution_plan": {
    "batches": [
      {
        "batch": 1,
        "issues": [456, 789],
        "mode": "parallel",
        "reason": "independent, no file overlap"
      },
      {
        "batch": 2,
        "issues": [123],
        "mode": "serial",
        "depends_on_batch": 1,
        "reason": "#123 touches auth.ts modified by #456"
      }
    ]
  },
  "skipped": [
    {"reason": "denylist", "detail": "touches .env.production"}
  ],
  "stats": {"total_found": 10, "processing": 5, "skipped": 3, "duplicate": 2}
}
```

### Phase 3: Execute

`triage-results.json` の `execution_plan` に従ってバッチ実行。

- parallel batch → 複数 `dev-flow` を Task subagent で並列起動
- serial batch → `dev-flow` を1つずつ直列実行
- バッチ間は `depends_on_batch` の順序で実行
- バッチ内の1issueが失敗しても他issueは続行
- 各issue完了後に `guard-check.sh --pre-execute` で累積変更量チェック

### Phase 4: Report

**出力先:**
- `claudedocs/night-patrol/YYYY-MM-DD.md` — 詳細レポート
- Telegram — 簡潔サマリー

**レポート形式:**

```markdown
# Night Patrol Report - 2026-04-01

## Summary
- 検出: 10件 → トリアージ後: 5件 → 処理: 3件
- ブランチ: `nightly/2026-04-01`
- 累積変更: 245行

## Completed
| Issue | PR | 変更行数 | 概要 |
|-------|-----|---------|------|
| #456 | #789 | 30 | Fix failing auth tests |

## Skipped
| Issue | 理由 |
|-------|------|
| #234 | 推定変更行数 > 500 |

## Failed
(なし)

## Duplicate/Filtered
- lint warning in auth.ts → 既存 #100 に追記

## Next Steps
- [ ] `nightly/2026-04-01` を確認して dev にマージ
- [ ] スキップされた #234 を手動対応検討
```

**Telegram 通知:**

```
Night Patrol 完了

3件完了 / 1件スキップ / 0件失敗
245行変更 (nightly/2026-04-01)

→ レポート: claudedocs/night-patrol/2026-04-01.md
```

## 安全ガード

| ガード | チェック箇所 | 条件 | アクション |
|--------|-------------|------|-----------|
| 破壊的変更検出 | triage (Step 3) | public API変更、DB migration含む | issueスキップ |
| 1issue変更行数上限 | triage (Step 3) + execute後 | 推定/実測 > `max_lines_per_issue` | issueスキップ |
| denylistパス | triage (Step 3) | 対象ファイルが `denylist_paths` に該当 | issueスキップ |
| denylistラベル | triage (Step 3) | `do-not-autofix` 等のラベル付き | issueスキップ |
| denylist issue番号 | scan (issue取得時) | `denylist_issues` に該当 | 取得段階で除外 |
| 累積変更量上限 | execute (各batch前) | 合計 > `max_cumulative_lines` | 残りバッチ全スキップ |

**ガード発動時の挙動:**
- スキップされたissueは `night-patrol.json` とレポートに記録
- ループ終了の場合でも Phase 4 (Report) は必ず実行
- ガード発動理由は全てトレース可能

## 設定 (skill-config.json)

```json
{
  "night-patrol": {
    "max_lines_per_issue": 500,
    "max_cumulative_lines": 2000,
    "denylist_paths": [".env*", "*.secret", "migrations/"],
    "denylist_labels": ["do-not-autofix", "needs-discussion"],
    "denylist_issues": [45, 78, 102],
    "allowed_labels": ["bug", "enhancement", "tech-debt"],
    "issue_label": "night-patrol",
    "telegram_chat_id": null
  }
}
```

## 既存スキルとの統合

```
night-patrol (1スキル、サブコマンドで個別Phase実行可)
├── Phase 1: scripts/* (通常) / code-audit-team (--deep)
├── Phase 2: scripts/* + LLM判断
├── Phase 3: dev-flow (既存、実装の8割)
│   ├── dev-issue-analyze
│   ├── dev-kickoff (→ plan → implement → validate → evaluate)
│   ├── git-pr
│   └── pr-iterate (→ pr-review → pr-fix)
├── Phase 4: scripts/generate-report.sh + Telegram通知
└── skill-retrospective (既存、ジャーナルログ)
```

- dev-flow は変更なし。issue番号を渡すだけ
- dev-flow の PR ターゲットブランチを `nightly/YYYY-MM-DD` に指定
  - **実装時の確認事項**: dev-flow / git-pr にベースブランチ指定オプションがあるか確認。なければ追加が必要
- dev-flow の出力（PR番号、ステータス）を night-patrol.json に記録

## ディレクトリ構成

```
night-patrol/
├── SKILL.md
├── scripts/
│   ├── scan-lint.sh
│   ├── scan-tests.sh
│   ├── scan-issues.sh
│   ├── check-duplicates.sh
│   ├── analyze-dependencies.sh
│   ├── guard-check.sh
│   └── generate-report.sh
└── references/
    └── safety-guards.md
```
