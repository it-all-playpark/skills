# gws CLI Sheets 操作パターン

スプレッドシート操作には `gws` CLI を使用する。

## 日本語シート名のJSON生成（必須パターン）

`--params` や `--json` に日本語を含む場合、シェルのエスケープ問題を回避するため **必ず python3 経由で JSON を生成** する:

```bash
# パターン: python3 でJSON生成 → シェル変数 → gws に渡す
PARAMS=$(python3 -c "
import json
print(json.dumps({
  'spreadsheetId': '<ID>',
  'range': r'パイプライン!A:I',
  'valueInputOption': 'USER_ENTERED'
}, ensure_ascii=False))
")
BODY=$(python3 -c "
import json
print(json.dumps({
  'values': [['企業名', '担当者名', '1', 'ステータス']]
}, ensure_ascii=False))
")
gws sheets spreadsheets values update --params "$PARAMS" --json "$BODY"
```

**注意点:**
- `range` 内の `!` は python の raw string（`r'...'`）で囲むこと
- `ensure_ascii=False` で日本語をそのまま出力すること
- シングルクォートの `--params '...'` では日本語エスケープエラーが発生するため使わないこと

## 読み取り

```bash
# ヘルパーコマンド（簡易読み取り）
gws sheets +read --spreadsheet "<ID>" --range "パイプライン!A:I"

# raw API（高度なオプションが必要な場合）
PARAMS=$(python3 -c "
import json
print(json.dumps({'spreadsheetId': '<ID>', 'range': r'パイプライン!A:I'}, ensure_ascii=False))
")
gws sheets spreadsheets values get --params "$PARAMS"
```

## 書き込み（更新）

特定行の値を更新する。**行番号は事前に読み取りで特定すること。**

```bash
PARAMS=$(python3 -c "
import json
print(json.dumps({
  'spreadsheetId': '<ID>',
  'range': r'パイプライン!A2:I2',
  'valueInputOption': 'USER_ENTERED'
}, ensure_ascii=False))
")
BODY=$(python3 -c "
import json
print(json.dumps({'values': [['企業名', '担当者', '2', ...]]}, ensure_ascii=False))
")
gws sheets spreadsheets values update --params "$PARAMS" --json "$BODY"
```

## 追記（append 禁止 → update で明示的行番号指定）

**重要: `append` は空行があるとテーブル範囲末尾（空行の後）に追加される問題がある。**
代わりに以下の手順で確実に追記する:

1. 対象シートを `+read` で全件読み取り
2. 最終データ行番号を特定（空でない最後の行を探す）
3. `values update` で「最終データ行 + 1」の行番号を指定して書き込み

```bash
# Step 1: 現在のデータを取得し次の行番号を算出
NEXT_ROW=$(gws sheets +read --spreadsheet "<ID>" --range "活動履歴!A:A" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
rows = data.get('values', [])
# 空でない最後の行を探す（末尾の空行をスキップ）
last = 0
for i, row in enumerate(rows):
    if row and row[0].strip():
        last = i
print(last + 2)  # 1-indexed + 次の行
")

# Step 2: 次の行に update で書き込み
PARAMS=$(python3 -c "
import json
print(json.dumps({
  'spreadsheetId': '<ID>',
  'range': r'活動履歴!A${NEXT_ROW}:H${NEXT_ROW}',
  'valueInputOption': 'USER_ENTERED'
}, ensure_ascii=False))
")
BODY=$(python3 -c "
import json
print(json.dumps({'values': [['企業名', '2026/3/14', '種別', ...]]}, ensure_ascii=False))
")
gws sheets spreadsheets values update --params "$PARAMS" --json "$BODY"
```

## 行番号の特定

企業名で検索して行番号を取得するパターン:

```bash
ROW_NUM=$(gws sheets +read --spreadsheet "<ID>" --range "パイプライン!A:I" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
rows = data.get('values', [])
target = '環境公害'  # 部分一致
for i, row in enumerate(rows):
    if row and target in row[0]:
        print(i + 1)  # 1-indexed
        break
")
```

## シート追加

```bash
PARAMS=$(python3 -c "
import json
print(json.dumps({'spreadsheetId': '<ID>'}, ensure_ascii=False))
")
BODY=$(python3 -c "
import json
print(json.dumps({'requests': [{'addSheet': {'properties': {'title': '顧客マスタ'}}}]}, ensure_ascii=False))
")
gws sheets spreadsheets batchUpdate --params "$PARAMS" --json "$BODY"
```

## 値のクリア

```bash
PARAMS=$(python3 -c "
import json
print(json.dumps({'spreadsheetId': '<ID>', 'range': r'活動履歴!A10:H10'}, ensure_ascii=False))
")
gws sheets spreadsheets values clear --params "$PARAMS"
```
