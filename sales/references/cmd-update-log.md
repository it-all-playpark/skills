# update / log — パイプライン更新・活動ログ

## update <企業名> — パイプライン更新 + 活動ログ

pipeline.yml を更新する。**具体的な営業活動（TEL、メール、訪問等）の記述が含まれる場合は、活動ログも自動作成する。**

1. `companies/` から企業を検索（[企業検索ロジック](data-and-config.md#企業検索ロジック)）
2. 現在の pipeline.yml を読み込み、変更箇所を特定
3. pipeline.yml を更新
4. **活動ログ判定**: 引数に営業活動の内容（TEL結果、商談結果、メール送信等）が含まれる場合:
   - `activities/YYYY-MM-DD_{type}.md` を作成（`log` サブコマンドと同じフォーマット）
   - typeは活動内容から自動判定（TEL, メール, 訪問, 日程再調整 等）
   - 純粋なステータス変更のみ（例: `--status "失注"`）の場合は活動ログ不要

```
/sales update 環境公害センター --status "提案中" --next-action "見積書作成" --deadline "2026-03-20"
```

### 失注時の御用伺いルール

ステータスが「失注」になる場合、**必ず御用伺いのネクストアクションを設定する**。失注は関係性の終了ではなく、将来の再アプローチの起点。

- `next_action`: 御用伺い（先方の状況に応じた具体的な確認事項を記載）
- `next_action_deadline`: 失注日から **3ヶ月後**
- `next_action_assignee`: 担当者名

これにより `/sales remind` が御用伺い時期を検知してフォローアップを促す。

## log <企業名> — 活動ログ追加（主要サブコマンド）

**活動履歴 + パイプラインの両方を更新する。** 営業活動の記録にはこれを使う。

1. `activities/YYYY-MM-DD_{type}.md` を作成（frontmatter + 内容）
2. pipeline.yml を自動更新:
   - `appointment_count` +1（type が meeting/初回ヒアリング/提案説明/見積説明/クロージングの場合）
   - `last_contact` → 活動日
   - `next_action` / `next_action_deadline` → 引数の値
3. 同日同typeのファイルが既存の場合はサフィックスを付与（`_2`）

```
/sales log 環境公害センター --date "2026-03-20" --type "提案説明" --method "オンライン" \
  --summary "動画×AI証憑管理のデモ実施" --result "具体的な見積依頼あり" \
  --next-action "見積書作成" --deadline "2026-03-25"
```
