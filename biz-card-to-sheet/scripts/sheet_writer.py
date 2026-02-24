#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "gspread>=6.0",
#     "google-auth-oauthlib>=1.0",
# ]
# ///
"""Write business card data to Google Spreadsheet via gspread with OAuth2."""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import gspread

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent


def load_env() -> dict[str, str]:
    """Load .env file from skill directory."""
    env_file = SKILL_DIR / ".env"
    if not env_file.exists():
        return {}
    env = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env

HEADERS = [
    "姓", "名", "姓ふりがな", "名ふりがな",
    "会社名", "部署", "役職",
    "郵便番号", "住所",
    "電話番号", "携帯番号", "FAX",
    "メールアドレス", "Webサイト", "SNS",
    "登録日時",
]

FIELD_KEYS = [
    "last_name", "first_name", "last_name_kana", "first_name_kana",
    "company", "department", "title",
    "postal_code", "address",
    "phone", "mobile", "fax",
    "email", "website", "sns",
    "registered_at",
]


def get_client(credentials_path: str | None = None) -> gspread.Client:
    """Authenticate with OAuth2 (Desktop app flow)."""
    kwargs = {}
    if credentials_path:
        kwargs["credentials_filename"] = credentials_path
    return gspread.oauth(**kwargs)


def create_spreadsheet(client: gspread.Client, name: str) -> gspread.Spreadsheet:
    """Create a new spreadsheet with headers."""
    sh = client.create(name)
    ws = sh.sheet1
    ws.append_row(HEADERS, value_input_option="USER_ENTERED")
    ws.format("1", {"textFormat": {"bold": True}})
    ws.freeze(rows=1)
    return sh


def find_duplicate(ws: gspread.Worksheet, last_name: str, first_name: str, company: str) -> int | None:
    """Check for duplicate by last_name + first_name + company. Returns row number if found."""
    records = ws.get_all_values()
    for i, row in enumerate(records[1:], start=2):  # skip header
        if len(row) >= 5 and row[0] == last_name and row[1] == first_name and row[4] == company:
            return i
    return None


def append_row(ws: gspread.Worksheet, data: dict) -> None:
    """Append a new row with the given data."""
    if not data.get("registered_at"):
        data["registered_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    row = [data.get(k, "") for k in FIELD_KEYS]
    ws.append_row(row, value_input_option="USER_ENTERED")


def col_letter(n: int) -> str:
    """Convert 1-based column number to letter(s). 1=A, 26=Z, 27=AA, etc."""
    result = ""
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        result = chr(65 + remainder) + result
    return result


def update_row(ws: gspread.Worksheet, row_num: int, data: dict) -> None:
    """Update an existing row."""
    if not data.get("registered_at"):
        data["registered_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    row = [data.get(k, "") for k in FIELD_KEYS]
    cell_range = f"A{row_num}:{col_letter(len(row))}{row_num}"
    ws.update(cell_range, [row], value_input_option="USER_ENTERED")


def main():
    parser = argparse.ArgumentParser(description="Write business card data to Google Spreadsheet")
    parser.add_argument("--credentials", help="Path to OAuth credentials.json")
    parser.add_argument("--spreadsheet-id", help="Existing spreadsheet ID")
    parser.add_argument("--create", metavar="NAME", help="Create new spreadsheet with this name")
    parser.add_argument("--data", help="JSON string of card data (or read from stdin)")
    parser.add_argument("--no-dedup", action="store_true", help="Skip duplicate check")
    parser.add_argument("--update-on-dup", action="store_true", help="Update existing row if duplicate found")
    args = parser.parse_args()

    # Load .env defaults
    env = load_env()

    # Read data
    if args.data:
        data = json.loads(args.data)
    else:
        data = json.loads(sys.stdin.read())

    client = get_client(args.credentials)

    # Resolve spreadsheet ID: CLI arg > .env > error
    spreadsheet_id = args.spreadsheet_id or env.get("SPREADSHEET_ID")

    # Create or open spreadsheet
    if args.create:
        sh = create_spreadsheet(client, args.create)
        result = {"action": "created", "spreadsheet_id": sh.id, "url": sh.url}
    elif spreadsheet_id:
        sh = client.open_by_key(spreadsheet_id)
        result = {"action": "opened", "spreadsheet_id": sh.id, "url": sh.url}
    else:
        print("Error: --spreadsheet-id or SPREADSHEET_ID in .env required", file=sys.stderr)
        sys.exit(1)

    ws = sh.sheet1

    # Duplicate check
    if not args.no_dedup:
        dup_row = find_duplicate(
            ws,
            data.get("last_name", ""),
            data.get("first_name", ""),
            data.get("company", ""),
        )
        if dup_row:
            if args.update_on_dup:
                update_row(ws, dup_row, data)
                result["status"] = "updated"
                result["row"] = dup_row
                print(json.dumps(result, ensure_ascii=False))
                return
            else:
                result["status"] = "duplicate_found"
                result["row"] = dup_row
                print(json.dumps(result, ensure_ascii=False))
                return

    # Append
    append_row(ws, data)
    result["status"] = "appended"
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
