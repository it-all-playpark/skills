---
name: dev-flow-improve
description: |
  Runs one dev-improve self-improvement cycle for the dev-flow pipeline:
  reconciles previous improvement hypotheses against journal telemetry, mines
  improvement candidates from 4 sources (doctor anomalies, failed-run RCA,
  W7 sunset triggers, PR-derived signals), files at most 2 self-improve
  issues, then implements each filed issue by running dev-flow serially.
  Merge is always human (existing invariant preserved).
  Use when: (1) weekly self-improvement cycle (cron/launchd 起動),
  (2) user asks to improve dev-flow itself from telemetry,
  (3) keywords: dev-flow改善, 自己改善, self-improve, improve cycle, dev-improve,
  自己改善ループ, 改善サイクル.
---

# dev-flow-improve

dev-flow 自己改善ループの起動 skill。orchestration の実体は dynamic workflow
`dev-improve`（`.claude/workflows/dev-improve.js`）が持つ。本 skill は
(1) workflow 起動、(2) 起票 issue への dev-flow 実行、(3) サマリ報告のみを行う。
設計: `claudedocs/2026-07-13-dev-improve-loop-design.md` / W7 分類は AGENTS.md 参照。

## Workflow

1. **現在時刻を取得**（workflow は Date API 禁止のため args で渡す）:
   Bash で `date -u +%Y-%m-%dT%H:%M:%SZ` を実行し `<TODAY>` とする。
2. **Workflow tool で dev-improve を起動**: `{ name: 'dev-improve', args: { today: '<TODAY>' } }`
   返り値: `{ issues_filed, candidates_found, reconcile, backlog_added, backpressure_skipped }`
3. **起票 issue を dev-flow で順次実装**: `issues_filed` の各番号について、返却順に
   **1 件ずつ直列に** Skill tool で `dev-flow` を起動する（並列禁止 — worktree / CI 競合回避）。
   - dev-flow が `needs_clarification` を返した場合: headless/cron 文脈では人間に即答できない。
     該当 issue に状況が記録されていることを確認し、その issue は保留のまま次へ進む
     （worktree は保持される。次に人間がセッションで再起動する）。
   - 1 件の dev-flow 失敗は次の issue の実行を妨げない（1 issue = 1 PR で独立）。
4. **サマリ報告**: 仮説突合結果（confirmed / not_confirmed / insufficient / unavailable）、
   起票 issue 番号とタイトル、各 dev-flow の PR URL と終端 status、backpressure_skipped を報告する。
   improve-cycle telemetry は workflow が journal 記録済み。dev-flow 各 run の telemetry は
   dev-flow 自身が記録する。

## 安全弁（詳細は AGENTS.md の W7 分類）

- issue 化は 1 サイクル最大 2 件（IMPROVE_MAX）+ open self-improve issue 2 件以上で
  backpressure skip（人間の merge ペースに自動同期）
- merge は常に人間 — dev-flow の merge tier / human merge invariant をそのまま継承
- 自動 revert なし — not_confirmed 仮説は revert 候補 issue として人間判断に委ねる
- workflow 内の失敗は fail-open（issue 0 件で終了）。ただし open issue 数の取得失敗のみ
  fail-closed（backpressure 扱い）

## Schedule 登録（週次）

macOS launchd に毎週土曜 01:00 のジョブを登録する（1 回だけ手動実行）:

```
bash dev-flow-improve/scripts/install-schedule.sh --install
```

`--print` で plist 内容の確認、`--uninstall` で解除。
