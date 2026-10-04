---
name: biz-card-to-sheet
description: >-
  Extract business card (名刺) information from images and register to Google Spreadsheet.
  Use when: (1) user sends a business card image and wants data extracted,
  (2) keywords like "名刺", "名刺登録", "名刺スキャン", "business card", "名刺をスプレッドシートに",
  (3) user wants to OCR a business card and save to Google Sheets,
  (4) user sends a photo/image of a 名刺 and asks to register or save the contact info.
  Accepts args: IMAGE_PATH [--spreadsheet-id ID] [--create NAME]
---

# Biz Card to Sheet

名刺画像から情報を抽出し、Google Spreadsheet に登録する。

## Prerequisites

- `uv` (スクリプトの inline metadata で依存を自動解決)
- OAuth2 credentials at `~/.config/gspread/credentials.json`
- Setup details: Read [references/setup-guide.md](references/setup-guide.md) if user needs help

## Workflow

1. Read the business card image (Claude's multimodal vision)
2. Extract all fields into structured JSON
3. Confirm extracted data with user
4. Write to Google Spreadsheet via `$SKILL_DIR/scripts/sheet_writer.py`

## Step 1: Read Image & Extract Fields

Use the Read tool to view the business card image. Extract these fields:

```json
{
  "last_name": "姓",
  "first_name": "名",
  "last_name_kana": "姓ふりがな (推測可)",
  "first_name_kana": "名ふりがな (推測可)",
  "company": "会社名",
  "department": "部署",
  "title": "役職",
  "postal_code": "郵便番号 (〒XXX-XXXX)",
  "address": "住所 (郵便番号を除く)",
  "phone": "電話番号",
  "mobile": "携帯番号",
  "fax": "FAX番号",
  "email": "メールアドレス",
  "website": "WebサイトURL",
  "sns": "SNSアカウント (カンマ区切り)"
}
```

Extraction rules:
- Split full name into 姓/名. If ambiguous, use spacing or common Japanese name patterns.
- Infer ふりがな from kanji when not printed. Mark as `(推測)` if inferred.
- Normalize phone numbers to hyphenated format: `03-1234-5678`
- Extract postal code separately from address. Format: `XXX-XXXX` (no 〒 prefix).
- `registered_at` is auto-populated by the script (current timestamp).
- If a field is not present on the card, use empty string `""`.

## Step 2: Confirm with User

Display extracted data in a table and ask user to confirm or correct:

```
| フィールド | 値 |
|---|---|
| 姓 | 山田 |
| 名 | 太郎 |
| ... | ... |
```

Ask: "この内容で登録してよいですか？修正があれば教えてください。"

## Step 3: Write to Spreadsheet

Resolve `$SKILL_DIR` to the absolute path of this skill's directory before running commands.
Use `uv run` to execute — dependencies are resolved automatically from inline script metadata.

### Default Spreadsheet ID

`$SKILL_DIR/.env` に `SPREADSHEET_ID` を設定済みの場合、`--spreadsheet-id` を省略できる。
優先順位: `--spreadsheet-id` flag > `.env` の `SPREADSHEET_ID`

### Append to default spreadsheet (typical usage)

```bash
uv run "$SKILL_DIR/scripts/sheet_writer.py" --data '{"last_name":"山田",...}'
```

### New spreadsheet (first time)

```bash
uv run "$SKILL_DIR/scripts/sheet_writer.py" --create "名刺管理" --data '{"last_name":"山田",...}'
```

Returns `spreadsheet_id` — set this in `$SKILL_DIR/.env` for subsequent calls.

### Append to specific spreadsheet (override)

```bash
uv run "$SKILL_DIR/scripts/sheet_writer.py" --spreadsheet-id ID --data '{"last_name":"山田",...}'
```

**Important**: Use `--data` flag with JSON string. Avoid piping via `echo` to prevent shell escaping issues with special characters in names or addresses.

### Duplicate handling

Default behavior checks last_name + first_name + company for duplicates.

- **Duplicate found**: Inform user and ask whether to skip or update.
- **Force update**: Add `--update-on-dup` flag.
- **Skip check**: Add `--no-dedup` flag.

### Script output

JSON result with status:
- `{"status": "appended", "url": "..."}` — new row added
- `{"status": "duplicate_found", "row": N, "url": "..."}` — duplicate detected
- `{"status": "updated", "row": N, "url": "..."}` — existing row updated
- `{"status": "created", "spreadsheet_id": "...", "url": "..."}` — new spreadsheet created

## Error Handling

- **Auth error / token expired**: Delete `~/.config/gspread/authorized_user.json` and retry (browser will open for re-auth).
- **`credentials.json` not found**: Guide user through [references/setup-guide.md](references/setup-guide.md).
- **Permission denied on spreadsheet**: Verify the OAuth-authenticated Google account has edit access to the spreadsheet.
- **Network error**: Inform user and retry the script command.

## Multiple Cards

When processing multiple business card images in one session:
1. Process each card sequentially
2. Show batch summary at the end with count of added/skipped/updated
3. Reuse the same spreadsheet ID across all cards
