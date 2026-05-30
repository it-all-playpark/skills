---
name: pr-iterate
description: |
  Iterate a PR until LGTM via a skill-scoped completion-condition loop.
  Use when: (1) PR needs review→fix rounds, (2) keywords: iterate, until LGTM
  Accepts args: <pr-number-or-url>
argument-hint: [pr-number]
arguments: [pr]
allowed-tools:
  - Task
  - Bash(gh:*)
  - Bash(~/.claude/skills/pr-iterate/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
hooks:
  Stop:
    - type: prompt
      prompt: |
        直近の会話だけを根拠に、対象 PR が LGTM に到達したか判定せよ。
        完了条件（両方必須）:
        - pr-reviewer の最新 verdict が approved
        - check-ci.sh の最新出力の status が passed
        両方を会話が明示していれば {"ok": true}。
        どちらか未達・不明なら {"ok": false, "reason": "<残作業を1文・日本語>"}。
        会話のアシスタント手番が7回を超えていれば {"ok": true, "reason": "max rounds reached (7)"}。
---

# PR Iterate: $pr

PR #$pr のレビュー指摘が解消され **approved + CI passed** になるまで、Stop hook が
本スキルを毎ターン再実行する。**ループ・iteration カウンタは書かない。**
Stop hook は会話だけを見て継続判定するので、各ターンで下記の状態を会話に明示すること。

## 1 ターンの手順

1. `pr-reviewer` subagent を `Task`（subagent_type: pr-reviewer）で呼び、PR #$pr の verdict を取得（read-only）。
2. `~/.claude/skills/pr-iterate/scripts/check-ci.sh $pr` を実行し CI status を取得。
3. **必ず次の1行をそのまま出力する**（Stop hook 判定の唯一の根拠）：
   `PR #$pr: verdict=<approved|request-changes|comment>, CI=<passed|failed|pending>`
   この行は approved で終了するターンを含め毎ターン出力する。
4. pr-reviewer の decision が `approved` かつ CI が `passed` なら、これまでの review→fix 経緯を日本語で
   簡潔にまとめた最終サマリー（PR 番号・主な指摘と対応・最終 CI 状態を含む）を構築し
   `gh pr comment $pr --body "<サマリー>"` で投稿して終了。
5. それ以外（decision が request-changes/comment、または CI failed）なら
   `pr-fixer` subagent を `Task`（subagent_type: pr-fixer）で呼び、`pr_number` と
   pr-reviewer の戻り値の `issues` を渡して修正+push させる。
6. ターンを終える（継続判定は Stop hook が行う）。

## 言語ルール
verdict.message / summary / 投稿文 / Stop hook の reason は日本語。

## Journal Logging
approved+CI passed 到達時に skill-retrospective へ記録（`$pr` は URL の可能性があるため
PR 番号を数値で導出して渡す）：
```bash
PR_NUM=$(gh pr view $pr --json number -q .number)
~/.claude/skills/skill-retrospective/scripts/journal.sh log pr-iterate success --issue $PR_NUM
```
