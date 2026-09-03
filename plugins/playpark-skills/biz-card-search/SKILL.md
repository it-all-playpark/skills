---
name: biz-card-search
description: >-
  Search business card (名刺) data registered in Google Spreadsheet by keyword.
  Use when: (1) user wants to search or look up a previously registered business card,
  (2) keywords like "名刺検索", "名刺探す", "名刺を調べる", "名刺を検索", "business card search",
  (3) user asks to find contact info by name or company name,
  (4) user wants to retrieve registered 名刺 data from the spreadsheet.
  Accepts args: KEYWORD [--spreadsheet-id ID] [--field name|company|all]
---

# Biz Card Search

Search registered business card data in Google Spreadsheet by partial keyword match.
Companion skill to `biz-card-to-sheet`.

## Prerequisites

- `uv` (inline script metadata resolves dependencies automatically)
- OAuth2 credentials at `~/.config/gspread/credentials.json`
  - Setup: see `biz-card-to-sheet/references/setup-guide.md`

## Workflow

1. Receive search keyword from user
2. Execute `$SKILL_DIR/scripts/sheet_reader.py` via `uv run`
3. Display results as a table (main columns: 姓, 名, 会社名, 部署, 役職, 電話番号, メールアドレス)
4. If 0 results, inform user and suggest alternative keywords or registering via `biz-card-to-sheet`

## Execute Search

Resolve `$SKILL_DIR` to the absolute path of this skill's directory.

`$SKILL_DIR/.env` の `SPREADSHEET_ID` をデフォルトで使用。`--spreadsheet-id` flag で上書き可能。

### Typical usage

```bash
uv run "$SKILL_DIR/scripts/sheet_reader.py" --query "山田"
```

### Filter by field

```bash
# Name fields only (姓/名/ふりがな)
uv run "$SKILL_DIR/scripts/sheet_reader.py" --query "山田" --field name

# Company only
uv run "$SKILL_DIR/scripts/sheet_reader.py" --query "プレイパーク" --field company
```

### Output

JSON array of matched records. Each record contains all field keys from `biz-card-to-sheet` schema.
Empty array `[]` if no matches. Show full details only when user requests a specific person.

## Error Handling

Same auth/permission patterns as `biz-card-to-sheet`. Key actions:
- **Token expired**: Delete `~/.config/gspread/authorized_user.json` and retry
- **No credentials**: Guide user through `biz-card-to-sheet/references/setup-guide.md`

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log biz-card-search success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log biz-card-search failure \
  --error-category <category> --error-msg "<message>"
```
