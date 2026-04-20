---
name: suica-to-csv
description: >
  Convert モバイルSuica残高ご利用明細 PDF to マネーフォワードクラウド経費 CSV import format.
  Use when: (1) user has a Suica PDF statement and wants CSV for expense reporting,
  (2) keywords like "Suica", "suica", "交通費CSV", "経費CSV", "MFクラウド", "マネーフォワード",
  "Suica CSV", "Suica変換", "交通費インポート",
  (3) user wants to convert IC card transaction history to expense CSV.
  Accepts args: PDF_PATH [-o output.csv]
model: haiku
effort: low
---

# suica-to-csv

Convert モバイルSuica残高ご利用明細 PDF → マネーフォワードクラウド経費 CSV.

## Usage

```
/suica-to-csv <pdf-path> [-o output.csv]
```

| Arg | Description |
|-----|-------------|
| pdf-path | Path to Suica PDF statement |
| -o | Output CSV path (default: CWD/suica_transactions.csv) |

## Workflow

1. **Read PDF** → Use Read tool to extract text from the Suica PDF
2. **Parse transactions** → Extract structured data from text using the parsing logic below
3. **Detect year** → Infer year from PDF filename pattern `_YYYYMMDD_` or ask user
4. **Write temp text file** → Save parsed transaction lines to a temp file
5. **Run converter** → Execute `scripts/suica_to_csv.py` with the temp file
6. **Report results** → Show summary (row count, total amount, operator breakdown)
7. **Cleanup** → Remove temp file

## PDF Text Format

The PDF contains lines in these formats:

```
MM DD 入 STATION_IN 出 STATION_OUT AMOUNT      # Train
MM DD ＊入 STATION_IN 出 STATION_OUT AMOUNT     # Train (transfer)
MM DD ﾊﾞｽ等 COMPANY AMOUNT                      # Bus
```

Amounts are negative integers (e.g., `-1,980`). Amount `0` entries are excluded.

## Parsing Rules

### Transaction text extraction from PDF

Extract only data lines matching the patterns above. Skip header/footer text like:
- `モバイル Ｓｕｉｃａ 残高ご利用明細`
- `利用履歴 （N件）`
- `月 日 種別 利用駅 種別 利用駅 入金・利用額`
- `ご利用ありがとうございます。`
- Lines with only `*`

Each data line should be normalized to: `MM DD TYPE STATION_INFO AMOUNT`

### Year detection

PDF filename pattern: `JE..._YYYYMMDD_YYYYMMDDHHMMSS.pdf`
- First YYYYMMDD = statement start date
- Second YYYY = export year
- Months >= 7 → start year, Months < 7 → end year

### Operator classification

| Station prefix | Operator | Example |
|---------------|----------|---------|
| 地 / 地　 | 東京メトロ | 地恵比寿, 地　新橋 |
| 都 / 都　 | 都営地下鉄 | 都　新橋 |
| 京王 | 京王電鉄 | 京王渋谷, 京王橋本 |
| 京急 | 京急電鉄 | 京急品川, 京急横浜 |
| JW / ＪＷ | JR西日本 | JW徳山, JW柳井 |
| ＭＲ / MR | モノレール | ＭＲＣＤ |
| (none) | JR東日本 | 宇都宮, 大崎, 新橋 |

### Bus classification

| Raw name | Payee |
|----------|-------|
| 関東自動 | 関東自動車 |
| 神奈中 | 神奈中バス |
| (others) | Use raw name |

### 経費科目

- Train (入/出) → `電車代`
- Bus (ﾊﾞｽ等) → `バス代`

## Output CSV

UTF-8 with BOM. Columns:

```
日付,支払先・内容,経費科目,金額（税込）,自社出席代表者名,自社出席者人数,
他社出席代表者名,他社出席者人数,メモ,費用負担部門名,費用負担部門コード,
プロジェクト名,税区分,通貨,為替レート,貸方勘定科目,貸方補助科目,事前申請番号
```

| Field | Value |
|-------|-------|
| 日付 | YYYY/MM/DD |
| 支払先・内容 | Operator name (JR東日本, 東京メトロ, etc.) |
| 経費科目 | 電車代 or バス代 |
| 金額（税込） | Absolute value (positive integer) |
| メモ | Train: `入駅 → 出駅` (prefixes stripped), Bus: company name |
| 通貨 | JPY |
| 為替レート | 1 |
| Others | Empty |

## Script

Converter script: `scripts/suica_to_csv.py`

```bash
python3 scripts/suica_to_csv.py <text-file> [--start-year YYYY] [--end-year YYYY]
```

The script reads a text file with one transaction per line and outputs `suica_transactions.csv` in CWD.

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log suica-to-csv success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log suica-to-csv failure \
  --error-category <category> --error-msg "<message>"
```
