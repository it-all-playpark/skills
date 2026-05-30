# pr-iterate goal 駆動移行 — 設計

- **日付**: 2026-05-30
- **対象**: `pr-iterate`（dev-flow ファミリーの先行移行ケース）
- **関連**: [[dev-flow-workflow-migration]] memory、PoC `.claude/agents/pr-reviewer.md` / `claudedocs/pr-review-wf-poc.js`
- **ステータス**: design（未着手）

## 背景と目的

dev-flow ファミリー（dev-flow / dev-kickoff / pr-iterate）の orchestration は現在、
大量の shell script（`init-*.sh` / `record-*.sh` / `flow-update.sh` / `check-resume.sh`）と
state ファイル（`iterate.json` / `flow.json` / `kickoff.json`）で **state machine** を
手組みしている。phase 遷移・retry ループ・compact recovery を全て自前で制御している。

本質は state 管理ではない。**「issue 番号を渡せば分析→計画→実装→検証→PR→レビュー→fix
まで完了させる」** ことであり、各フェーズには明確な完了条件（goal）がある。

Claude Code v2.1.139（2026-05-12）の `/goal` と、その下地である
**prompt/agent-based Stop hook** が、この「完了条件まで自律ループ」をネイティブに提供する。
これにより state machine の大半が不要になる。

pr-iterate は「PR が LGTM になるまで review→fix を繰り返す」= 単一逐次ループで、
この移行の最小・最良の踏み台。dev-flow が内部で pr-iterate を内包するため、
先に固めれば dev-flow 移行で再利用できる。

## パラダイム転換

| | 現状（state machine skill）| 本設計（goal 駆動）|
|---|---|---|
| ループ駆動 | `record-iteration.sh next` + 本文の手続き | **skill-scoped Stop hook が毎ターン完了条件を評価** |
| 完了判定 | LGTM を本文ロジックで判断 | **agent-based Stop hook が CI/verdict を実検証** |
| state 永続化 | `iterate.json` | Stop hook + Claude Code の `--resume` |
| 上限制御 | `max_iterations` カウンタ | 完了条件内の `Nターンで打ち切り` clause |
| compact recovery | `check-resume.sh` + `pre-compact-save.sh` | `--resume`（active goal/session 復元）|

### なぜ Workflow tool を使わないか

pr-iterate は**単一逐次ループ**（並列 fan-out が無い）。Workflow tool の本領は
parallel/pipeline の並列調整であり、逐次ループには過剰。さらに Workflow script は
filesystem/shell/skill 直接呼び不可で、全副作用が agent 経由になりオーバーヘッドが大きい。
Workflow tool は **child-split の並列 batch** にのみ温存し、dev-flow 移行時に評価する。

## アーキテクチャ

```
/pr-iterate 456            ← ① skill 起動（薄い）
  └ skill 本文が pr-reviewer を呼ぶ
       └ pr-reviewer subagent（既存）→ {decision, issues, summary}
  └ request-changes なら pr-fixer を呼ぶ
       └ pr-fixer subagent（新規）→ edit + commit + push → {applied[], skipped[]}
  └ ターン終了
  ┌──────────────────────────────────────────────┐
  │ ② skill-scoped Stop hook（agent-based）       │  ← ループの駆動者
  │   完了条件「verdict=approved かつ CI=passed」  │
  │   を subagent が実検証 → ok:false なら継続      │
  │                          ok:true なら終了      │
  └──────────────────────────────────────────────┘
```

3 つの責務に分離：

1. **skill（`pr-iterate/SKILL.md`）** — 起動口 + 完了条件の定義 + 1 ターンの手順
   （reviewer 呼ぶ→必要なら fixer 呼ぶ）。ループ制御は書かない
2. **Stop hook（skill frontmatter `hooks.Stop`）** — 完了条件を毎ターン実検証し、
   未達ならループ継続。goal 相当
3. **subagent** — `pr-reviewer`（既存・read-only verdict）と `pr-fixer`（新規・修正適用）

## pr-iterate 具体設計

### SKILL.md frontmatter

```yaml
---
name: pr-iterate
description: |
  Iterate a PR until LGTM via a skill-scoped completion-condition loop.
  Use when: PR needs review→fix rounds until approved + CI green.
  Accepts args: <pr-number-or-url>
arguments: [pr]
allowed-tools:
  - Agent          # pr-reviewer / pr-fixer 呼び出し
  - Bash(gh:*)     # check-ci / submit
  - Bash(~/.claude/skills/pr-iterate/scripts/*)
hooks:
  Stop:
    - type: agent
      prompt: |
        PR #$pr が LGTM か検証せよ。
        - pr-reviewer の直近 verdict が approved
        - check-ci.sh の status が passed
        両方満たせば {"ok": true}。未達なら
        {"ok": false, "reason": "<残作業を1文で>"}。
        20 ターン経過していれば {"ok": true, "reason": "max turns"} で打ち切る。
---
```

> **⚠️ 実装との差分（authoritative は Open questions §1 + plan + 実装済 `pr-iterate/SKILL.md`）**
> 上記スケッチは初期案。最終実装は以下が異なる：
> - Stop hook は `type: agent` ではなく **`type: prompt`**（会話判定。docs で `$pr` 非展開が判明し採用）
> - allowed-tools は `Agent` ではなく **`Task`**（subagent 呼び出し）
> - 完了条件の turn clause は 20 ではなく **7**（エンジンの 8 連続 block セーフガードに整合）
> - CI 条件は `passed` **または `no_checks`**（CI チェック皆無の PR も passing 扱い）
> - 最終 summary は `post-summary.sh` ではなく **本文が `gh pr comment` で投稿**（下記「残す決定論部分」参照）

### 本文ワークフロー（1 ターン分のみ）

```
1. pr-reviewer を Agent で呼ぶ（PR #$pr の verdict 取得、read-only）
2. verdict.decision == approved なら最終 summary を投稿して終了
3. request-changes / comment なら pr-fixer を Agent で呼ぶ
   （issues を渡す → edit + commit + push）
4. ターンを終える（次ターンに進むかは Stop hook が判定）
```

ループも iteration カウンタも書かない。Stop hook が「approved + CI passed」を
満たすまで本文を再実行させる。

### pr-fixer subagent（新規 `.claude/agents/pr-fixer.md`）

[[subagent-dispatch]] 5 要素準拠：

- **Objective**: pr-reviewer の `issues` に基づき PR 差分範囲内へ最小修正を適用、commit+push
- **Output**: `{applied: [{file, change_summary}], skipped: [{issue, reason}]}`（日本語）
- **Tools**: 使用可 Read/Edit/Bash(lint・test・git commit・git push)。禁止 Write（新規作成は issue が要求した場合のみ）、gh pr review
- **Boundary**: PR 差分範囲内のみ、`.github/workflows/` は issue 明示時のみ、main/dev 直接操作禁止、subagent spawn 禁止
- **model**: sonnet（副作用ありの実装系）/ **Token cap**: 2000 語・編集 15 ファイルまで

既存 `pr-fix` skill は subagent 化後に**削除**（no-backcompat 原則）。
`pr-fix/scripts/pr-setup.sh` / `pr-finish.sh` のロジックは pr-fixer 本文に内包。

> **実装メモ**: pr-fix skill の削除は dev-flow-doctor（family リスト・fixtures・baselines）
> + `skill-config.json` + README への波及が大きいため、**この PR では分離し follow-up issue 化**
> （minimal-coherent scope）。pr-fix は当面 standalone skill として残る（pr-iterate からは呼ばれない）。

### 廃止するもの

- `pr-iterate/scripts/init-iterate.sh`
- `pr-iterate/scripts/record-iteration.sh`
- `pr-iterate/scripts/check-resume.sh`
- `iterate.json`（state 永続化）と関連 schema
- `max_iterations` カウンタ（完了条件の turn clause が代替）

### 残す決定論部分

- `check-ci.sh` — 本文が CI status を取得（passed/failed/pending/no_checks 区別）。本文が
  その実出力を会話に明示し、prompt-type Stop hook が会話からそれを読んで完了判定する
- `pr-iterate-setup.sh` — standalone な PR checkout helper（state-free・Keep）

### 廃止に伴い置換したもの

- `post-summary.sh`（+ `references/summary-template.md`）— iterate.json の iteration 履歴に
  完全結合していたため**削除**。最終サマリーは本文（LLM ターン）が会話履歴から日本語で構築し
  `gh pr comment` で1回投稿する（approved+CI passed に到達したターンのみ。重複投稿の懸念なし）
- `check-lgtm.sh` — review-file 方式の LGTM 判定。subagent verdict 方式へ移行し**削除**
- 途中 iteration での `gh pr review` submit は廃止。冗長なレビューコメント連投を解消（挙動改善）

## compact / resume の扱い

- Claude Code の `--resume` / `--continue` が active な goal/session を復元する。
  pr-iterate のループ状態は会話履歴 + Stop hook 条件として復元される
- `pre-compact-save.sh`（hook）が読む `iterate.json` は廃止するため、
  pre-compact dump の対象から pr-iterate を外す。**`pre-compact-save.sh` の
  `ITERATE_STATE` 参照を削除する**（移行作業に含める）

## dev-flow への一般化（後続）

本パターンは dev-flow 全体に展開できる：

- **dev-flow single** = 「issue が分析→…→PR LGTM まで完了」を1つの完了条件にした
  skill-scoped agent-based Stop hook。判断系フェーズ（dev-plan-impl / dev-plan-review /
  dev-evaluate）は subagent
- **child-split** の並列 batch のみ Workflow tool で fan-out

pr-iterate で「skill-scoped Stop hook + subagent」パターンを実証してから dev-flow に適用する。

## Open questions

1. **agent-based Stop hook が skill 引数（`$pr`）を prompt に展開できるか。**
   → **解決済（公式 docs / Claude Code v2.1.158, 2026-05-30 確認）。展開不可。**
   hook の `prompt:` 内の `$ARGUMENTS` は **hook の JSON input**（`stop_hook_active` /
   `assistant_message` 等）に展開され、skill 引数 `$pr` には展開されない。
   `$pr` / `$N` / `$ARGUMENTS[N]` の skill 引数展開は **SKILL.md 本文のみ**。
   よって当初の Phase 0 spike は不要（docs で決着）、plan 本線の「hook prompt に `$pr`」は廃案。
   - **採用方式（prompt-type / 会話判定）**: SKILL.md 本文が毎ターン `$pr` を展開し
     pr-reviewer verdict と `check-ci.sh $pr` の実出力を会話に明示。`type: prompt` の
     Stop hook（Haiku 既定）が会話から `approved + CI passed` を判定し、未達なら
     `{"ok": false, "reason": ...}` で継続、20 ターン超で `{"ok": true}`。
     `/goal` と同一機構。引数不要・state ファイル不要・experimental な `type: agent` 不使用。
   - 補足: `type: agent` は **experimental（将来変更あり）**。Stop hook は **8 回連続 block で
     強制終了**のセーフガードがあるため、20 ターン上限はこれと整合させる（`stop_hook_active` 検知）。
2. **skill-scoped Stop hook の登録タイミング** — skill 起動と同時に有効化され、
   skill 終了で解除されるか。複数 skill が同時に Stop hook を持つ場合の合成挙動
3. **subagent 登録のセッション制約**（[[dev-flow-workflow-migration]] gotcha 1）—
   pr-fixer.md 新規作成後はセッション reload が必要

## テスト方針

- pr-fixer の決定論部分（diff 範囲判定・skip 理由生成）に bats
- Stop hook 完了条件の評価を、approved/CI 各状態の固定 transcript で検証
- E2E: 実 PR で review→fix→LGTM のループが Stop hook 駆動で回ることを確認

## 移行手順

1. ~~**Phase 0**: agent-based Stop hook の引数展開 spike~~ → **不要**（Open question 1 が
   公式 docs で決着。展開不可と確定し prompt-type / 会話判定方式を採用）
2. pr-fixer.md 作成 → セッション reload
3. pr-iterate/SKILL.md を goal 駆動（**prompt-type Stop hook / 会話判定**）に書き換え、
   state machine scripts 削除
4. `pre-compact-save.sh` の iterate.json 参照削除
5. 旧 pr-fix skill 削除
6. dev-flow / dev-kickoff の `Skill: pr-iterate` 呼び出し口が新形式で動くか確認

## 実行環境の前提（テスト時の注意）

`~/.claude/skills` は **メイン repo の作業ツリー**（`<...>/it-all-playpark/skills`）への
symlink。各 skill は repo ルート直下のディレクトリ（`~/.claude/skills/pr-iterate` =
`<repo>/pr-iterate`）。**この worktree のブランチに置いただけでは Claude Code は新コードを
ロードしない。** よって live スモーク（Task 3 Step 3）/ E2E（Task 8）は、新コードが
メイン repo 側の作業ツリーに存在する状態（このブランチを main repo でチェックアウト、
または merge 後）で実行する必要がある。
